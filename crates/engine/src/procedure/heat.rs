//! Steady and transient conduction (plan A §6).
//!
//! Steady is `(K + H) T = f`, where `K` is the conductivity, `H` the convection film and `f`
//! the convective, flux and source loads. A fixed temperature is a Constraint, not a load, so
//! it is eliminated by exactly the same `reduce`/`expand` pair a clamped displacement is; the
//! "reaction" a Constraint reports is then the heat that flows through it, in watts.
//!
//! Transient is the θ-method: `(C/Δt + θK) T_{n+1} = (C/Δt − (1−θ)K) T_n + f`, one
//! factorisation reused for every step. The requested Δt is an upper bound: a uniform increment
//! is reduced to reach `t_end` exactly. Prescribed temperatures are scaled by `amplitude(t)`,
//! and because the elimination is linear in the prescribed values, the coupling term is
//! assembled once at the base values and simply scaled — no re-reduction per step.

use crate::command::Field;
use crate::engine::OnProgress;
use crate::error::Error;
use crate::error::ErrorCode;
use crate::fem::assembly::{expand, pattern, reduce, resolve, Csr, Pattern, ResolvedConstraints};
use crate::fem::checks;
use crate::fem::heat::{capacity, conductivity, face_integrals, source, HeatLoad};
use crate::fem::problem::Problem;
use crate::par::Pool;
use crate::post::{extremes, reactions_per_constraint, Per};
use crate::procedure::{blank, report, retained_frame_count, time_grid, vector_field, History, StepResult};
use crate::solve::{direct::Direct, solve, LinearSolve, SolveInfo, SolveOptions};

fn finite_positive(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

fn valid_theta(theta: f64) -> bool {
    (0.0..=1.0).contains(&theta)
}

/// Require one positive transport property on every material used by the heat mesh.
///
/// These properties belong to the element-side Material extension point rather than the
/// built-in constitutive law, so this check applies unchanged when the law is supplied by a
/// plugin. A zero is also how an omitted optional property reaches the resolved Problem.
fn positive_material_property(
    p: &Problem<'_>,
    procedure: &str,
    field: &str,
    description: &str,
    value: fn(&crate::fem::element::Material) -> f64,
) -> Result<(), Error> {
    for (block, material) in p.material_of_block.iter().enumerate() {
        let material = &p.materials[material.expect("checks accepted the material assignments")];
        let got = value(material);
        if !finite_positive(got) {
            let body = &p.body_of_block[block];
            return Err(Error::new(
                ErrorCode::ModelIllPosed,
                format!("Body '{body}' cannot run {procedure}: {description} must be finite and positive, got {got}"),
            )
            .at(format!("body '{body}'"))
            .suggest(format!("material.add with {field}")));
        }
    }
    Ok(())
}

/// Steady heat needs conductivity; transient heat additionally needs thermal capacity `rho cp`.
fn validate_materials(p: &Problem<'_>, transient: bool) -> Result<(), Error> {
    let procedure = if transient { "heat-transient" } else { "heat-steady" };
    positive_material_property(p, procedure, "k", "conductivity k", |m| m.k)?;
    if transient {
        positive_material_property(p, procedure, "rho", "density rho", |m| m.rho)?;
        positive_material_property(p, procedure, "cp", "specific heat cp", |m| m.cp)?;
    }
    Ok(())
}

/// The assembled steady system and what went into it.
#[derive(Debug, Clone, PartialEq)]
pub struct HeatSystem {
    /// Conductivity plus the convection film `H`.
    pub k: Csr,
    /// Convective, flux and source loads.
    pub f: Vec<f64>,
    pub min_det_j: f64,
    /// Total heat entering through loads, in watts: the balance a Result reports.
    pub applied: f64,
}

/// `K + H` and `f` for one heat Problem, into a fresh copy of `pat.csr`.
///
/// Elements are walked in order and scattered through the same slot map the stiffness uses, so
/// the result is bit-identical whatever the thread count; the assembly is sequential because a
/// heat matrix is `dim²` times smaller than the elastic one it sits beside.
pub fn assemble(p: &Problem<'_>, pat: &Pattern) -> Result<HeatSystem, Error> {
    let mut k = pat.csr.clone();
    let mut f = vec![0.0; p.mesh.n_nodes()];
    let mut min_det_j = f64::INFINITY;
    let mut coords = Vec::new();
    let mut ke = Vec::new();
    let mut fe = Vec::new();
    let t = [0.0; 0];
    // Convection and flux add to the same two arrays, face by face in the Set's sorted order.
    for load in &p.heat_loads {
        let (faces, h, rhs) = match load {
            HeatLoad::Convection { faces, h, t_inf } => (faces, *h, *h * *t_inf),
            HeatLoad::Flux { faces, q } => (faces, 0.0, *q),
            HeatLoad::Source { .. } => continue,
        };
        for &face in &p.set(faces)?.faces {
            let kind = p.mesh.kind_of(face.elem);
            let nn = kind.n_nodes();
            coords.resize(nn * 3, 0.0);
            p.mesh.elem_coords(face.elem, &mut coords);
            ke.clear();
            ke.resize(nn * nn, 0.0);
            fe.clear();
            fe.resize(nn, 0.0);
            p.ctx(face.elem, &coords, &t)
                .and_then(|c| face_integrals(kind, &c, face.local, &mut ke, &mut fe))
                .map_err(|e| e.at(format!("element {}", face.elem)))?;
            for v in ke.iter_mut() {
                *v *= h;
            }
            for v in fe.iter_mut() {
                *v *= rhs;
            }
            scatter(pat, p, face.elem, &ke, &fe, &mut k, &mut f);
        }
    }

    for (bi, blk) in p.mesh.blocks.iter().enumerate() {
        let nn = blk.kind.n_nodes();
        let q: f64 = p
            .heat_loads
            .iter()
            .filter_map(|l| match l {
                HeatLoad::Source { bodies, q } if bodies.contains(&p.body_of_block[bi]) => Some(*q),
                _ => None,
            })
            .sum();
        for i in 0..blk.n_elems() {
            let elem = blk.first_elem + i as u32;
            coords.resize(nn * 3, 0.0);
            p.mesh.elem_coords(elem, &mut coords);
            ke.clear();
            ke.resize(nn * nn, 0.0);
            fe.clear();
            fe.resize(nn, 0.0);
            // One `?`: the context, the conductivity and the source fail on the same material
            // and the same element, so the first failure is the only reachable arm.
            let det = p
                .ctx(elem, &coords, &t)
                .and_then(|c| {
                    conductivity(blk.kind, &c, &mut ke).and_then(|det| match q {
                        0.0 => Ok(det),
                        q => source(blk.kind, &c, q, &mut fe).map(|()| det),
                    })
                })
                .map_err(|e| e.at(format!("element {elem}")))?;
            min_det_j = min_det_j.min(det);
            scatter(pat, p, elem, &ke, &fe, &mut k, &mut f);
        }
    }
    let applied = f.iter().sum();
    Ok(HeatSystem { k, f, min_det_j, applied })
}

/// `C = ∫ ρ c_p NᵀN dV` for the whole mesh, into a fresh copy of `pat.csr`.
pub fn assemble_capacity(p: &Problem<'_>, pat: &Pattern) -> Result<Csr, Error> {
    let mut c = pat.csr.clone();
    let mut f = vec![0.0; p.mesh.n_nodes()];
    let mut coords = Vec::new();
    let mut ce = Vec::new();
    let t = [0.0; 0];
    for blk in &p.mesh.blocks {
        let nn = blk.kind.n_nodes();
        for i in 0..blk.n_elems() {
            let elem = blk.first_elem + i as u32;
            coords.resize(nn * 3, 0.0);
            p.mesh.elem_coords(elem, &mut coords);
            ce.clear();
            ce.resize(nn * nn, 0.0);
            p.ctx(elem, &coords, &t)
                .and_then(|c| capacity(blk.kind, &c, &mut ce))
                .map_err(|e| e.at(format!("element {elem}")))?;
            scatter(pat, p, elem, &ce, &[], &mut c, &mut f);
        }
    }
    Ok(c)
}

/// Add one element's matrix and load into the global arrays through the pattern's slot map.
fn scatter(pat: &Pattern, p: &Problem<'_>, elem: u32, ke: &[f64], fe: &[f64], k: &mut Csr, f: &mut [f64]) {
    let slot = &pat.slot[pat.slot_ptr[elem as usize] as usize..pat.slot_ptr[elem as usize + 1] as usize];
    for (s, v) in slot.iter().zip(ke.iter()) {
        k.vals[*s as usize] += v;
    }
    for (a, &node) in p.mesh.elem_nodes(elem).iter().enumerate() {
        if let Some(v) = fe.get(a) {
            f[node as usize] += v;
        }
    }
}

/// Solve the steady conduction Step.
pub async fn steady(
    p: &Problem<'_>,
    opts: &SolveOptions,
    pool: &Pool,
    gpu: Option<&crate::gpu::Gpu>,
    mut progress: OnProgress<'_>,
) -> Result<StepResult, Error> {
    if let Some(e) = checks::all(p).into_iter().next() {
        return Err(e);
    }
    validate_materials(p, false)?;
    report(&mut progress, "assemble", 0.1, "building the conductivity matrix")?;
    let pat = pattern(p.mesh, 1);
    // The checks have already looked at every material, every Set and every Jacobian the
    // assembly touches, so what is left cannot fail — unlike the stiffness, the conductivity
    // never calls a material law.
    let sys = pool.install(|| assemble(p, &pat)).expect("the checks accepted this mesh");
    let rc = resolve(p).expect("the checks resolved the constraints");
    let red = reduce(&sys.k, &sys.f, &rc);
    let (t_f, solver) = solve(&red.k_ff, &red.f_f, opts, pool, gpu, &mut progress).await?;
    let t = expand(&red, &t_f);
    report(&mut progress, "post", 0.9, "recovering the temperature field")?;
    Ok(finish(p, &sys, &rc, &red.fixed, &t, solver))
}

/// The Result of a temperature field: the field itself, the heat each Constraint carries, and
/// the balance scalars a summary reports.
fn finish(
    p: &Problem<'_>,
    sys: &HeatSystem,
    rc: &ResolvedConstraints,
    fixed: &[u32],
    t: &[f64],
    solver: SolveInfo,
) -> StepResult {
    // The flow through a held node is `(K T − f)` there, which is the heat the support removes.
    let mut kt = vec![0.0; sys.k.n];
    sys.k.spmv(t, &mut kt);
    let mut flow = vec![0.0; sys.k.n];
    for &dof in fixed {
        flow[dof as usize] = -(kt[dof as usize] - sys.f[dof as usize]);
    }
    let mut res = blank(solver);
    res.reaction_quantity = crate::units::ReactionQuantity::Power;
    res.fields.insert(Field::Temperature, vector_field(t, 1));
    res.fields.insert(Field::Reaction, vector_field(&flow, 1));
    res.scalars.insert("min_det_j".to_string(), sys.min_det_j);
    res.scalars.insert("applied_total_x".to_string(), sys.applied);
    res.scalars.insert("applied_total_y".to_string(), 0.0);
    res.scalars.insert("applied_total_z".to_string(), 0.0);
    res.scalars.insert("rel_residual".to_string(), res.solver.rel_residual);
    res.extremes = res
        .fields
        .iter()
        .filter(|(_, f)| f.per == Per::Node)
        .flat_map(|(name, f)| extremes(f, p.mesh).into_iter().map(|e| (*name, e)))
        .collect();
    res.reactions = reactions_per_constraint(p, rc, &res.fields[&Field::Reaction]);
    res
}

/// Integrate the transient Step by the θ-method.
///
/// `solver` is accepted for symmetry with the other procedures but the transient path always
/// factorises directly: the whole point is that one factorisation serves every step, which an
/// iterative solver would throw away.
#[allow(clippy::too_many_arguments)]
pub fn transient(
    p: &Problem<'_>,
    dt: f64,
    t_end: f64,
    theta: f64,
    initial: f64,
    output_every: usize,
    amplitude: Option<&crate::procedure::Amplitude>,
    _solver: &SolveOptions,
    pool: &Pool,
    mut progress: OnProgress<'_>,
) -> Result<StepResult, Error> {
    if let Some(e) = checks::all(p).into_iter().next() {
        return Err(e);
    }
    validate_materials(p, true)?;
    let (n_steps, dt) = time_grid(dt, t_end)?;
    if !valid_theta(theta) {
        return Err(Error::schema(format!("a transient Step needs theta in [0, 1], got {theta}"))
            .at("theta")
            .suggest("step.add with theta between 0 (explicit Euler) and 1 (backward Euler)"));
    }
    report(&mut progress, "assemble", 0.1, "building the conductivity and capacity matrices")?;
    let pat = pattern(p.mesh, 1);
    let (sys, cap) = pool
        .install(|| assemble(p, &pat).and_then(|s| assemble_capacity(p, &pat).map(|c| (s, c))))
        .expect("the checks accepted this mesh");
    let rc = resolve(p).expect("the checks resolved the constraints");
    // `a = C/Δt + θK` is the matrix that is factorised once; `b = C/Δt − (1−θ)K` builds the
    // right-hand side from the previous temperature.
    let mut a = sys.k.clone();
    let mut b = sys.k.clone();
    for i in 0..a.vals.len() {
        let (c, k) = (cap.vals[i] / dt, sys.k.vals[i]);
        a.vals[i] = c + theta * k;
        b.vals[i] = c - (1.0 - theta) * k;
    }
    // Reducing `a` against a zero right-hand side leaves exactly `−A_fc u_c` at the base
    // prescribed values, which the amplitude scales linearly.
    let zeros = vec![0.0; a.n];
    let red = reduce(&a, &zeros, &rc);
    drop(zeros);
    // Positive transport properties and theta make this positive definite for ordinary heat
    // boundaries. A malformed extension or unsupported boundary must still be an Error rather
    // than taking down the host Worker.
    let mut factored = pool.install(|| Direct::factor(&red.k_ff))?;

    let g = |time: f64| amplitude.map_or(1.0, |amp| amp.at(time));
    let mut t = vec![initial; a.n];
    for (i, &dof) in red.fixed.iter().enumerate() {
        t[dof as usize] = red.u_fixed[i] * g(0.0);
    }
    let every = output_every.max(1);
    let frames = retained_frame_count(n_steps, every).expect("time_grid bounds the retained-frame count");
    let mut history = History::with_initial(Field::Temperature, t.clone(), frames);
    let mut rhs_full = vec![0.0; a.n];
    let mut rhs_f = vec![0.0; red.free.len()];
    let mut t_f = vec![0.0; red.free.len()];
    let mut solver = SolveInfo { solver: "cpu-direct", iterations: 0, rel_residual: 0.0, time_ms: 0.0 };
    for step in 1..=n_steps {
        let time = if step == n_steps { t_end } else { step as f64 * dt };
        b.spmv(&t, &mut rhs_full);
        let scale = g(time);
        for (i, &dof) in red.free.iter().enumerate() {
            rhs_f[i] = rhs_full[dof as usize] + sys.f[dof as usize] + scale * red.f_f[i];
        }
        // Propagate a rejected direct result instead of retaining a bad temperature history.
        solver = factored.solve(&rhs_f, &mut t_f)?;
        solver.iterations = step;
        t = expand(&red, &t_f);
        for (i, &dof) in red.fixed.iter().enumerate() {
            t[dof as usize] = red.u_fixed[i] * scale;
        }
        if step % every == 0 || step == n_steps {
            history.times.push(time);
            history.values.push(t.clone());
        }
        report(&mut progress, "solve", 0.1 + 0.8 * step as f64 / n_steps as f64, "stepping in time")?;
    }
    let mut res = finish(p, &sys, &rc, &red.fixed, &t, solver);
    res.scalars.insert("dt".to_string(), dt);
    res.scalars.insert("steps".to_string(), n_steps as f64);
    res.history = Some(history);
    Ok(res)
}

/// The min and max of each history row, which is what a Result summary shows for a transient.
pub fn history_extremes(h: &History) -> Vec<(f64, f64, f64)> {
    h.times
        .iter()
        .zip(&h.values)
        .map(|(&t, v)| {
            let lo = v.iter().copied().fold(f64::INFINITY, f64::min);
            let hi = v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            (t, lo, hi)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{finite_positive, valid_theta};

    #[test]
    fn transport_properties_and_theta_must_be_finite_and_in_range() {
        assert!(finite_positive(f64::MIN_POSITIVE));
        assert!(!finite_positive(0.0));
        assert!(!finite_positive(f64::INFINITY));
        assert!(!finite_positive(f64::NAN));
        assert!(valid_theta(0.0));
        assert!(valid_theta(1.0));
        assert!(!valid_theta(-f64::MIN_POSITIVE));
        assert!(!valid_theta(f64::NAN));
    }
}
