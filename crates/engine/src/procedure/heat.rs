//! Steady and transient conduction (plan A §6).
//!
//! Steady is `(K + H) T = f`, where `K` is the conductivity, `H` the convection film and `f`
//! the convective, flux and source loads. A radiating face adds a second film `H_r(T)` that
//! depends on the answer, so the Step becomes a Newton iteration through
//! [`iterate`](crate::procedure::iterate): assemble the film at the current temperature, solve,
//! repeat. Without a radiation Load not a line of that runs and the numbers are the linear
//! ones, byte for byte. A fixed temperature is a Constraint, not a load, so
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
use crate::fem::assembly::{expand, pattern, reactions, reduce, resolve, Csr, Pattern, ResolvedConstraints};
use crate::fem::checks;
use crate::fem::heat::{capacity, conductivity, face_film, face_integrals, radiative_film, source, HeatLoad};
use crate::fem::mpc::{self, Mpc};
use crate::fem::problem::Problem;
use crate::par::Pool;
use crate::post::{extremes, reactions_per_constraint, Per};
use crate::procedure::{
    blank, iterate, report, retained_frame_count, time_grid, vector_field, History, NonlinearControl, StepResult,
};
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
            // Radiation is state-dependent: `add_radiation` puts it in at each iterate.
            HeatLoad::Source { .. } | HeatLoad::Radiation { .. } => continue,
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

/// Does this Step radiate? A `false` keeps the linear single-solve path, byte for byte.
pub fn radiates(p: &Problem<'_>) -> bool {
    p.heat_loads.iter().any(|l| match l {
        HeatLoad::Radiation { .. } => true,
        HeatLoad::Convection { .. } | HeatLoad::Flux { .. } | HeatLoad::Source { .. } => false,
    })
}

/// Add `∫ h(T) NᵀN dS` into `k` and `∫ h(T) T_ref(T) N dS` into `f` for every radiating face,
/// reporting the same Set, material and folded-element failures [`assemble`] does — which is why
/// the procedures, having run the checks first, call it with an `expect`.
///
/// with the film frozen at the nodal temperatures `t`. Together those two are the whole
/// fourth-power law: `h(T)(T − T_ref(T)) ≡ σ ε (T⁴ − T∞⁴)`, so the converged answer carries no
/// error from the linearisation.
pub fn add_radiation(p: &Problem<'_>, pat: &Pattern, t: &[f64], k: &mut Csr, f: &mut [f64]) -> Result<(), Error> {
    let mut coords = Vec::new();
    let mut ke = Vec::new();
    let mut fe = Vec::new();
    let mut te = Vec::new();
    let none = [0.0; 0];
    for load in &p.heat_loads {
        let (faces, eps, t_inf) = match load {
            HeatLoad::Radiation { faces, emissivity, t_inf } => (faces, *emissivity, *t_inf),
            HeatLoad::Convection { .. } | HeatLoad::Flux { .. } | HeatLoad::Source { .. } => continue,
        };
        for &face in &p.set(faces)?.faces {
            let kind = p.mesh.kind_of(face.elem);
            let nn = kind.n_nodes();
            coords.resize(nn * 3, 0.0);
            p.mesh.elem_coords(face.elem, &mut coords);
            te.clear();
            te.extend(p.mesh.elem_nodes(face.elem).iter().map(|&n| t[n as usize]));
            ke.clear();
            ke.resize(nn * nn, 0.0);
            fe.clear();
            fe.resize(nn, 0.0);
            let film = |t_gp: f64| radiative_film(eps, t_inf, t_gp);
            p.ctx(face.elem, &coords, &none)
                .and_then(|c| face_film(kind, &c, face.local, &te, &film, &mut ke, &mut fe))
                .map_err(|e| e.at(format!("element {}", face.elem)))?;
            scatter(pat, p, face.elem, &ke, &fe, k, f);
        }
    }
    Ok(())
}

/// The first temperature the radiative iteration assembles at: the warmest temperature the
/// Step's boundary data mentions, and never below 1 K, so every radiating face starts with a
/// strictly positive film and the first linear system is non-singular even when the surrounding
/// is a 0 K sink.
fn radiation_start(p: &Problem<'_>) -> f64 {
    p.constraints
        .iter()
        .filter(|c| c.dofs[0])
        .map(|c| c.value)
        .chain(p.heat_loads.iter().filter_map(|l| match l {
            HeatLoad::Convection { t_inf, .. } | HeatLoad::Radiation { t_inf, .. } => Some(*t_inf),
            HeatLoad::Flux { .. } | HeatLoad::Source { .. } => None,
        }))
        .fold(1.0, f64::max)
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

/// Newton on the radiative film: rebuild `H_r(T)` and `f_r(T)`, re-reduce, factorise and solve
/// until the temperature stops moving, then answer the system assembled at the *converged*
/// temperature so the reported heat flow through the supports is the exact discrete residual.
///
/// Radiation always factorises directly, as the transient path already does: the matrix changes
/// every pass, which is the one thing an iterative solver's warm start cannot exploit.
fn steady_radiating(
    p: &Problem<'_>,
    pat: &Pattern,
    base: &HeatSystem,
    rc: &ResolvedConstraints,
    mpc: &Mpc,
    control: &NonlinearControl,
) -> Result<(HeatSystem, Vec<f64>, SolveInfo, usize), Error> {
    let mut t = vec![radiation_start(p); p.mesh.n_nodes()];
    let (solver, passes) = iterate(control, &mut t, "heat-steady", &mut |current, next| {
        let mut s = base.clone();
        add_radiation(p, pat, current, &mut s.k, &mut s.f).expect("the checks accepted this mesh");
        let (kt, ft) = mpc::transform(&s.k, &s.f, mpc);
        let red = reduce(&kt, &ft, rc, &mpc.slaves);
        let mut factored = Direct::factor(&red.k_ff)?;
        let mut t_f = vec![0.0; red.free.len()];
        let info = factored.solve(&red.f_f, &mut t_f).expect("a factorised solve");
        *next = expand(&red, &t_f);
        // A tied node has to carry its recovered temperature into the next pass, because the
        // radiative film is built from the field itself.
        mpc::recover(mpc, next);
        Ok(info)
    })?;
    let mut converged = base.clone();
    add_radiation(p, pat, &t, &mut converged.k, &mut converged.f).expect("the checks accepted this mesh");
    converged.applied = converged.f.iter().sum();
    Ok((converged, t, solver, passes))
}

/// Solve the steady conduction Step.
pub async fn steady(
    p: &Problem<'_>,
    opts: &SolveOptions,
    control: &NonlinearControl,
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
    let fixed: Vec<u32> = rc.fixed.iter().map(|&(dof, _)| dof).collect();
    // With one DOF per node a bonded contact ties temperature: the two parts are at the same
    // temperature across the interface, which is a perfect thermal contact.
    let mpc = mpc::build(p).expect("the checks built the multipoint constraints");
    let (sys, t, solver, passes) = match radiates(p) {
        true => {
            let (sys, t, mut solver, passes) = pool.install(|| steady_radiating(p, &pat, &sys, &rc, &mpc, control))?;
            // The passes are what the Step actually did; the factorised solves inside them each
            // report zero, which would be a misleading iteration count for a host to show.
            solver.iterations = passes;
            (sys, t, solver, Some(passes))
        }
        false => {
            let (kt, ft) = pool.install(|| mpc::transform(&sys.k, &sys.f, &mpc));
            let red = reduce(&kt, &ft, &rc, &mpc.slaves);
            let (t_f, solver) = solve(&red.k_ff, &red.f_f, opts, pool, gpu, &mut progress).await?;
            let mut t = expand(&red, &t_f);
            mpc::recover(&mpc, &mut t);
            (sys, t, solver, None)
        }
    };
    report(&mut progress, "post", 0.9, "recovering the temperature field")?;
    let mut res = finish(p, &sys, &rc, &fixed, &mpc, &t, solver);
    if let Some(passes) = passes {
        res.scalars.insert("nonlinear_iterations".to_string(), passes as f64);
    }
    res.warnings = mpc.warnings;
    Ok(res)
}

/// The Result of a temperature field: the field itself, the heat each Constraint carries, and
/// the balance scalars a summary reports.
fn finish(
    p: &Problem<'_>,
    sys: &HeatSystem,
    rc: &ResolvedConstraints,
    fixed: &[u32],
    mpc: &Mpc,
    t: &[f64],
    solver: SolveInfo,
) -> StepResult {
    // The flow through a held node is `−(K T − f)` there, which is the heat the support
    // removes; the original operator and load, with the tie's own flux folded into the masters
    // it holds, exactly as a structural reaction is built.
    let flow: Vec<f64> = reactions(&sys.k, t, &sys.f, fixed, mpc).into_iter().map(|v| -v).collect();
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

/// One θ-method increment with a radiating face: Newton on the radiative film until the
/// temperature stops moving. `t` enters as `T_n` and leaves as `T_{n+1}`.
///
/// The θ-method takes the radiative flux `R(T) = H_r(T) T − f_r(T)` at both ends of the
/// increment. Its explicit half `R(T_n)` is a constant of the pass loop and is computed once;
/// its implicit half is the linearised film, exact once the passes have converged.
#[allow(clippy::too_many_arguments)]
fn radiating_increment(
    p: &Problem<'_>,
    pat: &Pattern,
    sys: &HeatSystem,
    rc: &ResolvedConstraints,
    mpc: &Mpc,
    a_linear: &Csr,
    zeros: &[f64],
    rhs_full: &[f64],
    theta: f64,
    scale: f64,
    control: &NonlinearControl,
    step: usize,
    t: &mut Vec<f64>,
) -> Result<(SolveInfo, usize), Error> {
    let mut hk = pat.csr.clone();
    let mut hf = vec![0.0; a_linear.n];
    add_radiation(p, pat, t, &mut hk, &mut hf).expect("the checks accepted this mesh");
    let mut r_n = vec![0.0; a_linear.n];
    hk.spmv(t, &mut r_n);
    for (r, f) in r_n.iter_mut().zip(&hf) {
        *r -= f;
    }
    let where_ = format!("heat-transient increment {step}");
    iterate(control, t, &where_, &mut |current, next| {
        let mut hk = pat.csr.clone();
        let mut hf = vec![0.0; a_linear.n];
        add_radiation(p, pat, current, &mut hk, &mut hf).expect("the checks accepted this mesh");
        let mut a = a_linear.clone();
        for (v, h) in a.vals.iter_mut().zip(&hk.vals) {
            *v += theta * h;
        }
        let (at, _) = mpc::transform(&a, zeros, mpc);
        let red = reduce(&at, zeros, rc, &mpc.slaves);
        let mut factored = Direct::factor(&red.k_ff)?;
        // Everything on the right-hand side is a load on the original numbering, so it moves
        // to the transformed one the same way `Tᵀf` does.
        let load: Vec<f64> = (0..a_linear.n)
            .map(|dof| rhs_full[dof] + sys.f[dof] + theta * hf[dof] - (1.0 - theta) * r_n[dof])
            .collect();
        let load = mpc::transpose_load(mpc, &load);
        let mut rhs = vec![0.0; red.free.len()];
        for (i, &dof) in red.free.iter().enumerate() {
            rhs[i] = load[dof as usize] + scale * red.f_f[i];
        }
        let mut x = vec![0.0; red.free.len()];
        let info = factored.solve(&rhs, &mut x).expect("a factorised solve");
        *next = expand(&red, &x);
        for (i, &dof) in red.fixed.iter().enumerate() {
            next[dof as usize] = red.u_fixed[i] * scale;
        }
        mpc::recover(mpc, next);
        Ok(info)
    })
}

/// Integrate the transient Step by the θ-method.
///
/// `solver` is accepted for symmetry with the other procedures but the transient path always
/// factorises directly: the whole point is that one factorisation serves every step, which an
/// iterative solver would throw away. A radiation Load gives that up knowingly — `C/Δt +
/// θ(K + H + H_r(T))` depends on the answer, so it is rebuilt and refactorised inside every
/// pass of every increment. Without one, the single factorisation stands.
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
    control: &NonlinearControl,
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
    let mpc = mpc::build(p).expect("the checks built the multipoint constraints");
    // Only `a` is transformed. The recurrence needs `TᵀB T v`, and `T v` is the temperature
    // field itself, so `b` stays on the original numbering and `Tᵀ` is applied to `B T` once
    // per increment — one transform instead of two, and no reduced state to carry.
    let (at, ft) = pool.install(|| mpc::transform(&a, &sys.f, &mpc));
    let red = reduce(&at, &zeros, &rc, &mpc.slaves);
    // Positive transport properties and theta make this positive definite for ordinary heat
    // boundaries. A malformed extension or unsupported boundary must still be an Error rather
    // than taking down the host Worker.
    let radiating = radiates(p);
    let mut factored = match radiating {
        true => None,
        false => Some(pool.install(|| Direct::factor(&red.k_ff))?),
    };

    let g = |time: f64| amplitude.map_or(1.0, |amp| amp.at(time));
    let mut t = vec![initial; a.n];
    for (i, &dof) in red.fixed.iter().enumerate() {
        t[dof as usize] = red.u_fixed[i] * g(0.0);
    }
    let every = output_every.max(1);
    let frames = retained_frame_count(n_steps, every).expect("time_grid bounds the retained-frame count");
    let mut history = History::with_initial(Field::Temperature, t.clone(), frames);
    let mut carried = vec![0.0; a.n];
    let mut rhs_full = vec![0.0; a.n];
    let mut rhs_f = vec![0.0; red.free.len()];
    let mut t_f = vec![0.0; red.free.len()];
    let mut solver = SolveInfo { solver: "cpu-direct", iterations: 0, rel_residual: 0.0, time_ms: 0.0 };
    let mut passes = 0usize;
    for step in 1..=n_steps {
        let time = if step == n_steps { t_end } else { step as f64 * dt };
        b.spmv(&t, &mut carried);
        rhs_full = mpc::transpose_load(&mpc, &carried);
        let scale = g(time);
        match &mut factored {
            Some(factored) => {
                for (i, &dof) in red.free.iter().enumerate() {
                    rhs_f[i] = rhs_full[dof as usize] + ft[dof as usize] + scale * red.f_f[i];
                }
                // A factorised direct solve cannot fail; `LinearSolve` returns a Result for the
                // iterative solvers, which can run out of iterations.
                solver = factored.solve(&rhs_f, &mut t_f).expect("a factorised solve");
                t = expand(&red, &t_f);
            }
            None => {
                let (info, used) = pool.install(|| {
                    radiating_increment(
                        p, &pat, &sys, &rc, &mpc, &a, &zeros, &carried, theta, scale, control, step, &mut t,
                    )
                })?;
                solver = info;
                passes = passes.max(used);
            }
        }
        solver.iterations = step;
        for (i, &dof) in red.fixed.iter().enumerate() {
            t[dof as usize] = red.u_fixed[i] * scale;
        }
        mpc::recover(&mpc, &mut t);
        if step % every == 0 || step == n_steps {
            history.times.push(time);
            history.values.push(t.clone());
        }
        report(&mut progress, "solve", 0.1 + 0.8 * step as f64 / n_steps as f64, "stepping in time")?;
    }
    let sys = match radiating {
        true => {
            let mut s = sys;
            add_radiation(p, &pat, &t, &mut s.k, &mut s.f).expect("the checks accepted this mesh");
            s.applied = s.f.iter().sum();
            s
        }
        false => sys,
    };
    let mut res = finish(p, &sys, &rc, &red.fixed, &mpc, &t, solver);
    if radiating {
        res.scalars.insert("nonlinear_iterations".to_string(), passes as f64);
    }
    res.scalars.insert("dt".to_string(), dt);
    res.scalars.insert("steps".to_string(), n_steps as f64);
    res.history = Some(history);
    res.warnings = mpc.warnings;
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
