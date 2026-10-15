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
use crate::fem::assembly::{expand, pattern_coupled, reduce, resolve, Csr, Pattern, ResolvedConstraints};
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
    // Every material-axis component has to conduct, so the weakest of the three is the one to
    // report; an isotropic material repeats one value three times and this is unchanged.
    positive_material_property(p, procedure, "k", "conductivity k", |m| m.k[0].min(m.k[1]).min(m.k[2]))?;
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
    /// Right-hand-side power Σf in W, before subtracting outgoing convection.
    pub applied: f64,
    /// Integrated film coefficients ∫hN dA in W/K, for computing outgoing power.
    pub film: Vec<f64>,
}

/// `K + H` and `f` for one heat Problem, into a fresh copy of `pat.csr`.
///
/// Elements are walked in order and scattered through the same slot map the stiffness uses, so
/// the result is bit-identical whatever the thread count; the assembly is sequential because a
/// heat matrix is `dim²` times smaller than the elastic one it sits beside.
pub fn assemble(p: &Problem<'_>, pat: &Pattern, mpc: &Mpc) -> Result<HeatSystem, Error> {
    let mut k = pat.csr.clone();
    let mut f = vec![0.0; p.mesh.n_nodes()];
    let mut film = vec![0.0; p.mesh.n_nodes()];
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
            // A thermal contact is handled below, on the slave faces its own Coupling names.
            HeatLoad::Source { .. } | HeatLoad::Radiation { .. } | HeatLoad::Contact { .. } => continue,
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
            for (&node, v) in p.mesh.elem_nodes(face.elem).iter().zip(&mut fe) {
                film[node as usize] += h * *v;
                *v *= rhs;
            }
            scatter(pat, p, face.elem, &ke, &fe, &mut k, &mut f);
        }
    }

    // Thermal contact resistance (#85): `mpc.contact` holds the rows of a bonded tie that a
    // `contact.thermal` overrides — `mpc::build` skipped eliminating them, so both sides stay
    // free unknowns and the interface is instead a conductance directly in `K`. `checks::all`
    // (`unknown_thermal_contacts`) has already matched every `of` to a Coupling in this Step.
    // The lumped nodal area `Aₙ` reuses this same loop's `face_integrals` on the slave faces:
    // `film` fixed at 1 makes its `vec` output exactly `∫Nₙ dS`, unscaled.
    for load in &p.heat_loads {
        let HeatLoad::Contact { of, h } = load else { continue };
        let (owner, coupling) = p
            .couplings
            .iter()
            .enumerate()
            .find(|(_, c)| c.name() == of)
            .expect("checks::all matched every contact.thermal to a Coupling in this Step");
        // `contact.thermal` only ever names a bonded contact (the Command checks), whose
        // second Set is the slave.
        let slave = coupling.sets()[1];
        let mut area = vec![0.0; p.mesh.n_nodes()];
        for &face in &p.set(slave)?.faces {
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
            for (&node, &a) in p.mesh.elem_nodes(face.elem).iter().zip(&fe) {
                area[node as usize] += a;
            }
        }
        // `w(eₙ − Σaₖeₖ)(eₙ − Σaₖeₖ)ᵀ`: symmetric, positive semi-definite, exact where the
        // pairing is node-to-node and consistent otherwise because the weights `aₖ` are a
        // partition of unity. `pattern_coupled(mesh, 1, mpc.contact_pairs())` made room for
        // every entry this touches.
        for row in mpc.contact.iter().filter(|r| r.owner == owner) {
            let w = *h * area[row.slave as usize];
            k.add_at(row.slave, row.slave, w);
            for &(mk, ak) in &row.masters {
                k.add_at(row.slave, mk, -w * ak);
                k.add_at(mk, row.slave, -w * ak);
            }
            for &(mk, ak) in &row.masters {
                for &(ml, al) in &row.masters {
                    k.add_at(mk, ml, w * ak * al);
                }
            }
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
    Ok(HeatSystem { k, f, min_det_j, applied, film })
}

/// Does this Step radiate? A `false` keeps the linear single-solve path, byte for byte.
pub fn radiates(p: &Problem<'_>) -> bool {
    p.heat_loads.iter().any(|l| match l {
        HeatLoad::Radiation { .. } => true,
        HeatLoad::Convection { .. } | HeatLoad::Flux { .. } | HeatLoad::Source { .. } | HeatLoad::Contact { .. } => {
            false
        }
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
            HeatLoad::Convection { .. }
            | HeatLoad::Flux { .. }
            | HeatLoad::Source { .. }
            | HeatLoad::Contact { .. } => continue,
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

/// Fold physical outward radiation into the linear system's applied load. The tangent film
/// is only a solver device: its fictitious RHS is not externally supplied heat. Calls for the
/// two endpoints are sequential, so one radiation matrix and its two nodal buffers suffice.
fn subtract_radiation(p: &Problem<'_>, pat: &Pattern, t: &[f64], weight: f64, sys: &mut HeatSystem) {
    let mut hk = pat.csr.clone();
    let mut hf = vec![0.0; hk.n];
    add_radiation(p, pat, t, &mut hk, &mut hf).expect("the checks accepted this mesh");
    let mut power = vec![0.0; hk.n];
    hk.spmv(t, &mut power);
    for ((f, outgoing), source) in sys.f.iter_mut().zip(power).zip(hf) {
        let outgoing = weight * (outgoing - source);
        *f -= outgoing;
        sys.applied -= outgoing;
    }
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
            HeatLoad::Flux { .. } | HeatLoad::Source { .. } | HeatLoad::Contact { .. } => None,
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
        let info = factored.solve(&red.f_f, &mut t_f)?;
        *next = expand(&red, &t_f);
        // A tied node has to carry its recovered temperature into the next pass, because the
        // radiative film is built from the field itself.
        mpc::recover(mpc, next);
        Ok(info)
    })?;
    let mut converged = base.clone();
    subtract_radiation(p, pat, &t, 1.0, &mut converged);
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
    // `mpc` is built before the Pattern because a thermal contact's excluded rows need room in
    // it that no element creates (`pattern_coupled`, plan B §5).
    let mpc = mpc::build(p).expect("the checks built the multipoint constraints");
    let pat = pattern_coupled(p.mesh, 1, &mpc.contact_pairs());
    // The checks have already looked at every material, every Set and every Jacobian the
    // assembly touches, so what is left cannot fail — unlike the stiffness, the conductivity
    // never calls a material law.
    let sys = pool.install(|| assemble(p, &pat, &mpc)).expect("the checks accepted this mesh");
    let rc = resolve(p).expect("the checks resolved the constraints");
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
    let mut res = finish(p, &sys, &rc, &mpc, &t, &t, &vec![0.0; t.len()], solver);
    if let Some(passes) = passes {
        res.scalars.insert("nonlinear_iterations".to_string(), passes as f64);
    }
    res.warnings = mpc.warnings;
    Ok(res)
}

/// The Result of a temperature field: the field itself, the heat each Constraint carries, and
/// the balance scalars a summary reports. `evaluated` is the steady temperature or the last
/// transient θ-stage temperature; `capacity_rate` is C(Tnew−Told)/dt (zero in steady state).
/// Positive reactions remove heat. Net applied power minus removal equals stored energy rate.
#[allow(clippy::too_many_arguments)]
fn finish(
    p: &Problem<'_>,
    sys: &HeatSystem,
    rc: &ResolvedConstraints,
    mpc: &Mpc,
    t: &[f64],
    evaluated: &[f64],
    capacity_rate: &[f64],
    solver: SolveInfo,
) -> StepResult {
    // Start on the original numbering, including storage BEFORE transferring a slave's
    // residual to a held master. Internal interface flux is not a support reaction.
    let mut residual = vec![0.0; sys.k.n];
    sys.k.spmv(evaluated, &mut residual);
    for (i, r) in residual.iter_mut().enumerate() {
        *r += capacity_rate[i] - sys.f[i];
    }
    let tied = mpc::transpose_load(mpc, &residual);
    drop(residual);
    let mut flow = vec![0.0; sys.k.n];
    for &(dof, _) in &rc.fixed {
        flow[dof as usize] = -tied[dof as usize];
    }
    drop(tied);
    let mut res = blank(solver);
    res.reaction_quantity = crate::units::ReactionQuantity::Power;
    res.fields.insert(Field::Temperature, vector_field(t, 1));
    res.fields.insert(Field::Reaction, vector_field(&flow, 1));
    res.scalars.insert("min_det_j".to_string(), sys.min_det_j);
    let outgoing: f64 = sys.film.iter().zip(evaluated).map(|(h, t)| h * t).sum();
    res.scalars.insert("applied_total_x".to_string(), sys.applied - outgoing);
    res.scalars.insert("storage_power".to_string(), capacity_rate.iter().sum());
    // Scale the conservation residual by the assembled power terms (a backward-error
    // denominator), not the net power, which legitimately vanishes at film equilibrium.
    let matrix_power: f64 =
        sys.k.vals.iter().zip(&sys.k.col_idx).map(|(k, j)| (k * evaluated[*j as usize]).abs()).sum();
    let power_scale =
        matrix_power + sys.f.iter().map(|f| f.abs()).sum::<f64>() + capacity_rate.iter().map(|c| c.abs()).sum::<f64>();
    res.scalars.insert("power_balance_scale".to_string(), power_scale);
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
    drop(hk);
    drop(hf);
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
        // Reuse the film RHS for the complete original load, then transfer it once. Drop
        // each scratch before the next phase so contact does not add a retained nodal vector.
        for (dof, f) in hf.iter_mut().enumerate() {
            *f = rhs_full[dof] + sys.f[dof] + theta * *f - (1.0 - theta) * r_n[dof];
        }
        let load = mpc::transpose_load(mpc, &hf);
        drop(hf);
        let mut red = reduce(&at, zeros, rc, &mpc.slaves);
        drop(at);
        let mut factored = Direct::factor(&red.k_ff)?;
        for (i, &dof) in red.free.iter().enumerate() {
            red.f_f[i] = load[dof as usize] + scale * red.f_f[i];
        }
        drop(load);
        let mut x = vec![0.0; red.free.len()];
        let info = factored.solve(&red.f_f, &mut x)?;
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
    // `mpc` is built before the Pattern for the same reason as in `steady`: a thermal contact's
    // excluded rows need room in it that no element creates.
    let mpc = mpc::build(p).expect("the checks built the multipoint constraints");
    let pat = pattern_coupled(p.mesh, 1, &mpc.contact_pairs());
    let (sys, cap) = pool
        .install(|| assemble(p, &pat, &mpc).and_then(|s| assemble_capacity(p, &pat).map(|c| (s, c))))
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
    // Only `a` is transformed. The recurrence needs `TᵀB T v`, and `T v` is the temperature
    // field itself, so `b` stays on the original numbering and `Tᵀ` is applied to `B T` once
    // per increment — one transform instead of two, and no reduced state to carry.
    let (at, _) = pool.install(|| mpc::transform(&a, &zeros, &mpc));
    let red = reduce(&at, &zeros, &rc, &mpc.slaves);
    drop(at);
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
    // The first history/radiation state must satisfy the same tie as every later state.
    mpc::recover(&mpc, &mut t);
    let every = output_every.max(1);
    let frames = retained_frame_count(n_steps, every).expect("time_grid bounds the retained-frame count");
    let mut history = History::with_initial(Field::Temperature, t.clone(), frames);
    let mut previous = Vec::new();
    let mut rhs_full = vec![0.0; a.n];
    let mut rhs_f = vec![0.0; red.free.len()];
    let mut t_f = vec![0.0; red.free.len()];
    let mut solver = SolveInfo { solver: "cpu-direct", iterations: 0, rel_residual: 0.0, time_ms: 0.0 };
    let mut passes = 0usize;
    for step in 1..=n_steps {
        let time = if step == n_steps { t_end } else { step as f64 * dt };
        b.spmv(&t, &mut rhs_full);
        let scale = g(time);
        previous.clone_from(&t);
        match &mut factored {
            Some(factored) => {
                for (f, applied) in rhs_full.iter_mut().zip(&sys.f) {
                    *f += applied;
                }
                let load = mpc::transpose_load(&mpc, &rhs_full);
                for (i, &dof) in red.free.iter().enumerate() {
                    rhs_f[i] = load[dof as usize] + scale * red.f_f[i];
                }
                drop(load);
                // Reject a bad direct result without retaining an invalid temperature history.
                solver = factored.solve(&rhs_f, &mut t_f)?;
                t = expand(&red, &t_f);
            }
            None => {
                let (info, used) = pool.install(|| {
                    radiating_increment(
                        p, &pat, &sys, &rc, &mpc, &a, &zeros, &rhs_full, theta, scale, control, step, &mut t,
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
    // Iteration scratch is no longer needed while forming the physical balance fields.
    drop(factored);
    drop(red);
    drop(zeros);
    drop(rhs_full);
    drop(rhs_f);
    drop(t_f);
    drop(a);
    drop(b);
    let mut sys = sys;
    if radiating {
        // Nonlinear theta integration averages endpoint fluxes, not flux at T_theta.
        subtract_radiation(p, &pat, &previous, 1.0 - theta, &mut sys);
        subtract_radiation(p, &pat, &t, theta, &mut sys);
    }
    let evaluated: Vec<f64> = previous.iter().zip(&t).map(|(old, new)| (1.0 - theta) * old + theta * new).collect();
    // Reuse the last internal temperature buffer: balance recovery needs its rate after the
    // θ-stage temperature is formed, and no longer needs it after applying the capacity.
    let mut rate = previous;
    for (old, new) in rate.iter_mut().zip(&t) {
        *old = (new - *old) / dt;
    }
    let mut capacity_rate = vec![0.0; cap.n];
    cap.spmv(&rate, &mut capacity_rate);
    drop(rate);
    let mut res = finish(p, &sys, &rc, &mpc, &t, &evaluated, &capacity_rate, solver);
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
