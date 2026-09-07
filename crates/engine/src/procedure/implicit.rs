//! Implicit dynamics: the HHT-α method on the consistent mass, one factorisation per Step.
//!
//! `M a + C v + K u = f` with Rayleigh damping `C = αR·M + βR·K`. The α-method (Hilber,
//! Hughes and Taylor 1977) evaluates the internal and damping forces between the ends of the
//! increment:
//!
//! `M a₁ + (1+α)(C v₁ + K u₁) − α(C v₀ + K u₀) = (1+α) f₁ − α f₀`
//!
//! with Newmark's `u₁ = ũ + βΔt² a₁`, `v₁ = ṽ + γΔt a₁` and the one-knob parameters
//! `β = (1−α)²/4`, `γ = ½ − α`. `α = 0` is average acceleration: second order, unconditionally
//! stable, and exactly energy-conserving for a linear system. `α ∈ [−⅓, 0)` keeps second
//! order and adds numerical damping that grows with frequency, which is what takes the
//! mesh-frequency ringing out of a suddenly loaded model.
//!
//! Substituting the Newmark relations turns the equation of motion into a linear system whose
//! matrix `K_eff = cM·M + cK·K` is a fixed linear combination of two matrices on one sparsity
//! pattern: positive definite, factorised once, back-substituted every step. That is the shape
//! `heat::transient` already has, with the mass in place of the capacity.
//!
//! The unknown of that system is the acceleration `a₁` (Hughes' *a-form*), not the
//! displacement. The two are the same equations up to the factor `βΔt²`, but the d-form's
//! corrector `a₁ = (u₁ − ũ)/(βΔt²)` divides a round-off-level difference by `βΔt²`, which at
//! two hundred steps per period amplifies the factorisation's rounding a thousandfold into the
//! acceleration and, through the velocity, lets it accumulate step after step. Solving for the
//! acceleration and adding `βΔt² a₁` to the predictor keeps every state to round-off.
//!
//! The initial acceleration is solved, never assumed: `M_ff a₀ = (f(0) − C v₀ − K u₀)_f`, one
//! extra factorisation dropped before the loop. A suddenly applied load starts accelerating at
//! `t = 0⁺`, and `a₀ = 0` would be wrong from the first step.

use std::collections::BTreeMap;

use crate::command::Field;
use crate::engine::OnProgress;
use crate::error::{Error, ErrorCode};
use crate::fem::assembly::{self, assemble_stiffness, expand, pattern, reduce, resolve, Csr, ResolvedConstraints};
use crate::fem::checks;
use crate::fem::loads::assemble_loads;
use crate::fem::mpc::Mpc;
use crate::fem::problem::Problem;
use crate::par::Pool;
use crate::post::{extremes, reactions_per_constraint, Per};
use crate::procedure::modal::assemble_mass;
use crate::procedure::static_::stress_fields;
use crate::procedure::{blank, report, retained_frame_count, time_grid, vector_field, Amplitude, History, StepResult};
use crate::solve::{direct::Direct, LinearSolve};

/// The time-stepping constants of one Step: the α-method's parameters, the increment and the
/// Rayleigh coefficients — everything the predictor, the corrector and the effective stiffness
/// need, so a nonlinear Step can reuse them with a tangent stiffness in place of `K`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Scheme {
    pub alpha: f64,
    pub beta: f64,
    pub gamma: f64,
    pub dt: f64,
    /// `C = rayleigh_alpha · M + rayleigh_beta · K`.
    pub rayleigh_alpha: f64,
    pub rayleigh_beta: f64,
}

impl Scheme {
    /// Validate the knobs and derive `β = (1−α)²/4`, `γ = ½ − α` from `α`.
    pub fn new(alpha: f64, dt: f64, rayleigh_alpha: f64, rayleigh_beta: f64) -> Result<Scheme, Error> {
        if !(-1.0 / 3.0..=0.0).contains(&alpha) {
            return Err(Error::schema(format!("an implicit Step needs alpha in [-1/3, 0], got {alpha}"))
                .at("alpha")
                .suggest("step.add with alpha 0 (Newmark average acceleration) or -0.05 (HHT-α)"));
        }
        for (value, field) in [(rayleigh_alpha, "rayleighAlpha"), (rayleigh_beta, "rayleighBeta")] {
            if !(value.is_finite() && value >= 0.0) {
                return Err(Error::schema(format!("{field} must be finite and non-negative, got {value}"))
                    .at(field)
                    .suggest("step.add with rayleighAlpha \"0 Hz\" and rayleighBeta \"0 s\""));
            }
        }
        let beta = (1.0 - alpha) * (1.0 - alpha) / 4.0;
        Ok(Scheme { alpha, beta, gamma: 0.5 - alpha, dt, rayleigh_alpha, rayleigh_beta })
    }

    /// `(cM, cK)` of the effective matrix `K_eff = cM·M + cK·K` the acceleration solves
    /// against: `cM = 1 + (1+α)γΔt·αR`, `cK = (1+α)(βΔt² + γΔt·βR)`. Dividing both by `βΔt²`
    /// gives the displacement form's `1/(βΔt²) + (1+α)γαR/(βΔt)` and `(1+α)(1 + γβR/(βΔt))`.
    pub fn effective(&self) -> (f64, f64) {
        let Scheme { alpha, beta, gamma, dt, rayleigh_alpha, rayleigh_beta } = *self;
        (
            1.0 + (1.0 + alpha) * gamma * dt * rayleigh_alpha,
            (1.0 + alpha) * (beta * dt * dt + gamma * dt * rayleigh_beta),
        )
    }
}

/// The integrator's state and working vectors, all of full DOF length.
pub struct State {
    pub u: Vec<f64>,
    pub v: Vec<f64>,
    pub a: Vec<f64>,
    /// Newmark predictors `ũ`, `ṽ`.
    pub u_tilde: Vec<f64>,
    pub v_tilde: Vec<f64>,
    /// Scratch and the assembled right-hand side.
    pub x: Vec<f64>,
    pub r: Vec<f64>,
}

impl State {
    pub fn new(u: Vec<f64>, v: Vec<f64>, a: Vec<f64>) -> State {
        let n = u.len();
        State { u, v, a, u_tilde: vec![0.0; n], v_tilde: vec![0.0; n], x: vec![0.0; n], r: vec![0.0; n] }
    }
}

/// Newmark predictors from the state at `t₀`: `ũ = u + Δt v + Δt²(½−β) a`, `ṽ = v + Δt(1−γ) a`.
pub fn predict(s: &Scheme, st: &mut State) {
    for i in 0..st.u.len() {
        st.u_tilde[i] = st.u[i] + s.dt * st.v[i] + s.dt * s.dt * (0.5 - s.beta) * st.a[i];
        st.v_tilde[i] = st.v[i] + s.dt * (1.0 - s.gamma) * st.a[i];
    }
}

/// `R = scale·f − M·αR[(1+α)ṽ − αv₀] − K·[(1+α)(βR ṽ + ũ) − α(βR v₀ + u₀)]` into `st.r`, where
/// `scale = (1+α) g(t₁) − α g(t₀)` is the α-method's load combination: the equation of motion
/// with `u₁ = ũ + βΔt² a₁`, `v₁ = ṽ + γΔt a₁` substituted and everything known moved to the
/// right, so that `K_eff a₁ = R`.
///
/// `st.a` is dead between `predict` and `correct`, so it serves as the second scratch vector.
pub fn right_hand_side(s: &Scheme, m: &Csr, k: &Csr, f: &[f64], scale: f64, st: &mut State) {
    let ap = 1.0 + s.alpha;
    for i in 0..st.x.len() {
        st.x[i] = s.rayleigh_alpha * (ap * st.v_tilde[i] - s.alpha * st.v[i]);
    }
    m.spmv(&st.x, &mut st.r);
    for i in 0..st.x.len() {
        st.x[i] =
            ap * (s.rayleigh_beta * st.v_tilde[i] + st.u_tilde[i]) - s.alpha * (s.rayleigh_beta * st.v[i] + st.u[i]);
    }
    k.spmv(&st.x, &mut st.a);
    for ((r, a), fi) in st.r.iter_mut().zip(&st.a).zip(f) {
        *r = scale * fi - *r - *a;
    }
}

/// Newmark correctors once `st.a` holds `a₁`: `u₁ = ũ + βΔt² a₁`, `v₁ = ṽ + γΔt a₁`.
pub fn correct(s: &Scheme, st: &mut State) {
    for i in 0..st.u.len() {
        st.u[i] = st.u_tilde[i] + s.beta * s.dt * s.dt * st.a[i];
        st.v[i] = st.v_tilde[i] + s.gamma * s.dt * st.a[i];
    }
}

/// `M·(ca·a + cv_m·v) + K·(cv_k·v + cu·u)` into `out`: the shape of every force balance here.
/// With `C = αR M + βR K`, `[0, αR, βR, 1]` is `C v + K u`, `[1, αR, βR, 0]` is `M a + C v`.
fn combine(m: &Csr, k: &Csr, st: &mut State, [ca, cv_m, cv_k, cu]: [f64; 4], out: &mut [f64]) {
    for i in 0..st.x.len() {
        st.x[i] = ca * st.a[i] + cv_m * st.v[i];
    }
    m.spmv(&st.x, out);
    for i in 0..st.x.len() {
        st.x[i] = cv_k * st.v[i] + cu * st.u[i];
    }
    k.spmv(&st.x, &mut st.r);
    for (o, r) in out.iter_mut().zip(&st.r) {
        *o += r;
    }
}

/// `½ vᵀ M v + ½ uᵀ K u`: what average acceleration conserves for a linear system under no
/// load, and what HHT dissipates.
fn energy(m: &Csr, k: &Csr, st: &mut State) -> f64 {
    m.spmv(&st.v, &mut st.r);
    let kinetic: f64 = st.v.iter().zip(&st.r).map(|(v, mv)| 0.5 * v * mv).sum();
    k.spmv(&st.u, &mut st.r);
    let strain: f64 = st.u.iter().zip(&st.r).map(|(u, ku)| 0.5 * u * ku).sum();
    kinetic + strain
}

/// Integrate one implicit dynamics Step.
#[allow(clippy::too_many_arguments)]
pub fn run(
    p: &Problem<'_>,
    dt: f64,
    t_end: f64,
    alpha: f64,
    rayleigh: (f64, f64),
    initial_velocity: Option<&[f64]>,
    output_every: usize,
    amplitude: Option<&Amplitude>,
    pool: &Pool,
    mut progress: OnProgress<'_>,
) -> Result<StepResult, Error> {
    // A tie transforms both operators and the state every step; base motion is where that
    // machinery earns its keep, and it is not here yet.
    if let Some(c) = p.couplings.first() {
        return Err(Error::unsupported(&format!(
            "implicit dynamics with a multipoint constraint ('{}' ties two parts)",
            c.name()
        ))
        .at("step.procedure")
        .suggest("step.add with procedure 'static', or constraint.remove the contact"));
    }
    // `K_eff` is positive definite with or without supports, so a free body is a legitimate
    // model here, as it is for the explicit and modal procedures.
    if let Some(e) = checks::all(p).into_iter().find(|e| e.code != ErrorCode::ConstraintRigidModes) {
        return Err(e);
    }
    let (n_steps, dt) = time_grid(dt, t_end)?;
    let s = Scheme::new(alpha, dt, rayleigh.0, rayleigh.1)?;
    let rc = resolve(p).expect("the checks resolved the constraints");
    // The amplitude scales the loads only. A prescribed displacement that moved would carry a
    // velocity and an acceleration of its own, and this procedure holds both at zero.
    if amplitude.is_some() && rc.fixed.iter().any(|&(_, value)| value != 0.0) {
        return Err(Error::unsupported("an amplitude on an implicit Step with a non-zero prescribed displacement")
            .at("amplitude")
            .suggest("constraint.fix the moving Set, or drive the model through its Loads"));
    }
    report(&mut progress, "assemble", 0.1, "building the stiffness and mass matrices")?;
    let dpn = p.dofs_per_node();
    let pat = pattern(p.mesh, dpn);
    // One `?`: the stiffness, the mass and the loads fail on the same materials and the same
    // Sets, so only the first of them is an arm a test can take.
    let (a, m, applied, f) = pool.install(|| {
        assemble_stiffness(p, &pat).and_then(|a| {
            assemble_mass(p, &pat, false).and_then(|m| {
                let mut f = a.f_thermal.clone();
                assemble_loads(p, &mut f).map(|applied| (a, m, applied, f))
            })
        })
    })?;
    let n = a.k.n;
    let (c_m, c_k) = s.effective();
    let mut k_eff = pat.csr.clone();
    for ((e, mv), kv) in k_eff.vals.iter_mut().zip(&m.vals).zip(&a.k.vals) {
        *e = c_m * mv + c_k * kv;
    }
    // The unknown is the acceleration, which is zero on every held DOF, so both reductions run
    // against zero prescribed values; the prescribed displacements enter through `K ũ`.
    let rc0 = ResolvedConstraints {
        fixed: rc.fixed.iter().map(|&(dof, _)| (dof, 0.0)).collect(),
        owner: rc.owner.clone(),
        inert: rc.inert.clone(),
    };
    let zeros = vec![0.0; n];
    let red = reduce(&k_eff, &zeros, &rc0, &[]);
    drop(k_eff);
    if red.free.is_empty() {
        return Err(Error::new(
            ErrorCode::ModelIllPosed,
            "implicit dynamics has no free displacement DOFs; every displacement DOF is constrained",
        )
        .at("constraints")
        .suggest("constraint.remove on an over-constraining displacement constraint"));
    }
    // Positive definite for the admissible `α`, non-negative Rayleigh coefficients and a
    // non-negative density; a malformed material must still be an Error, not a crash.
    let mut factored = pool.install(|| Direct::factor(&red.k_ff))?;

    let g = |time: f64| amplitude.map_or(1.0, |amp| amp.at(time));
    // Held DOFs sit at their prescribed value with zero velocity and acceleration throughout.
    let mut u = vec![0.0; n];
    let mut v = initial_velocity.map_or_else(|| vec![0.0; n], <[f64]>::to_vec);
    for &(dof, value) in &rc.fixed {
        u[dof as usize] = value;
        v[dof as usize] = 0.0;
    }
    let mut st = State::new(u, v, vec![0.0; n]);
    // `M_ff a₀ = (g(0) f − C v₀ − K u₀)_f`.
    let mut q = vec![0.0; n];
    combine(&m, &a.k, &mut st, [0.0, s.rayleigh_alpha, s.rayleigh_beta, 1.0], &mut q);
    for (qi, fi) in q.iter_mut().zip(&f) {
        *qi = g(0.0) * fi - *qi;
    }
    let red0 = reduce(&m, &q, &rc0, &[]);
    let mut sol_f = vec![0.0; red.free.len()];
    let mut solver = Direct::factor(&red0.k_ff)
        .map_err(|_| {
            Error::new(
                ErrorCode::ModelIllPosed,
                "the mass matrix is singular on the free DOFs: every Body with a free DOF needs a density",
            )
            .at("materials")
            .suggest("material.add with rho, e.g. \"7850 kg/m^3\", then material.assign")
        })
        .and_then(|mut m_ff| m_ff.solve(&red0.f_f, &mut sol_f))?;
    st.a = expand(&red0, &sol_f);
    drop(red0);
    let e0 = energy(&m, &a.k, &mut st);

    let every = output_every.max(1);
    let frames = retained_frame_count(n_steps, every).expect("time_grid bounds the retained-frame count");
    let mut history = History::with_initial(Field::Displacement, st.u.clone(), frames);
    let mut rhs_f = vec![0.0; red.free.len()];
    let mut g_end = g(0.0);
    let mut load_scale = g_end;
    for step in 1..=n_steps {
        let (t0, t1) = ((step - 1) as f64 * dt, if step == n_steps { t_end } else { step as f64 * dt });
        g_end = g(t1);
        load_scale = (1.0 + s.alpha) * g_end - s.alpha * g(t0);
        if step == n_steps {
            // `C v₀ + K u₀` of the last increment: the α-method carries it into its balance.
            combine(&m, &a.k, &mut st, [0.0, s.rayleigh_alpha, s.rayleigh_beta, 1.0], &mut q);
        }
        predict(&s, &mut st);
        right_hand_side(&s, &m, &a.k, &f, load_scale, &mut st);
        for (i, &dof) in red.free.iter().enumerate() {
            rhs_f[i] = st.r[dof as usize];
        }
        // A bad direct result stops the Step before an invalid state enters the history.
        solver = factored.solve(&rhs_f, &mut sol_f)?;
        st.a = expand(&red, &sol_f);
        correct(&s, &mut st);
        if step % every == 0 || step == n_steps {
            history.times.push(t1);
            history.values.push(st.u.clone());
        }
        report(&mut progress, "solve", 0.1 + 0.8 * step as f64 / n_steps as f64, "stepping in time")?;
    }
    solver.iterations = n_steps;
    drop(factored);
    drop(red);
    drop(rhs_f);
    drop(sol_f);
    report(&mut progress, "post", 0.9, "recovering fields")?;
    let e_end = energy(&m, &a.k, &mut st);

    // Reactions carry the inertia. They are the α-method's own end-of-increment balance,
    // `M a₁ + (1+α)(C v₁ + K u₁) − α(C v₀ + K u₀) − ((1+α) f₁ − α f₀)` on the held DOFs, which
    // is `M a + C v + K u − f` at α = 0 and the force the solved equations actually equilibrate
    // otherwise. The applied totals are the same d'Alembert force summed over every DOF, so the
    // two close to round-off whatever α, exactly as a static Step's do.
    let mut f_eff = vec![0.0; n];
    let ap = 1.0 + s.alpha;
    combine(&m, &a.k, &mut st, [1.0, ap * s.rayleigh_alpha, ap * s.rayleigh_beta, s.alpha], &mut f_eff);
    let mut totals = [0.0; 3];
    for (i, fe) in f_eff.iter_mut().enumerate() {
        *fe = load_scale * f[i] - *fe + s.alpha * q[i];
        if i % dpn < 3 {
            totals[i % dpn] += *fe;
        }
    }
    drop(q);
    let r = assembly::reactions(&a.k, &st.u, &f_eff, &red_fixed(&rc), &Mpc::none());
    drop(f_eff);
    let mut fields = BTreeMap::new();
    fields.insert(Field::Displacement, vector_field(&st.u, dpn));
    fields.insert(Field::Reaction, vector_field(&r, dpn));
    stress_fields(p, &st.u, pool, &mut fields);

    let mut res = blank(solver);
    res.scalars.insert("min_det_j".to_string(), a.min_det_j);
    res.scalars.insert("dt".to_string(), dt);
    res.scalars.insert("steps".to_string(), n_steps as f64);
    res.scalars.insert("alpha".to_string(), s.alpha);
    res.scalars.insert("beta".to_string(), s.beta);
    res.scalars.insert("gamma".to_string(), s.gamma);
    res.scalars.insert("energy_initial".to_string(), e0);
    res.scalars.insert("energy_final".to_string(), e_end);
    for (c, axis) in ["x", "y", "z"].iter().enumerate() {
        res.scalars.insert(format!("applied_total_{axis}"), totals[c]);
        res.scalars.insert(format!("load_total_{axis}"), applied.force[c] * g_end);
    }
    res.scalars.insert("rel_residual".to_string(), res.solver.rel_residual);
    res.extremes = fields
        .iter()
        .filter(|(_, fd)| fd.per == Per::Node)
        .flat_map(|(name, fd)| extremes(fd, p.mesh).into_iter().map(|e| (*name, e)))
        .collect();
    res.reactions = reactions_per_constraint(p, &rc, &fields[&Field::Reaction]);
    res.fields = fields;
    res.history = Some(history);
    Ok(res)
}

/// The held DOF ids, ascending, as `assembly::reactions` wants them.
fn red_fixed(rc: &ResolvedConstraints) -> Vec<u32> {
    rc.fixed.iter().map(|&(dof, _)| dof).collect()
}

#[cfg(test)]
mod tests {
    use super::{correct, predict, right_hand_side, Scheme, State};
    use crate::fem::assembly::Csr;
    use crate::ErrorCode;

    fn scalar(value: f64) -> Csr {
        Csr { n: 1, row_ptr: vec![0, 1], col_idx: vec![0], vals: vec![value] }
    }

    #[test]
    fn alpha_zero_is_average_acceleration_and_minus_a_third_is_the_hht_limit() {
        let s = Scheme::new(0.0, 0.1, 0.0, 0.0).unwrap();
        assert_eq!((s.beta, s.gamma), (0.25, 0.5));
        let s = Scheme::new(-1.0 / 3.0, 0.1, 0.0, 0.0).unwrap();
        assert!((s.beta - 4.0 / 9.0).abs() < 1e-15 && (s.gamma - 5.0 / 6.0).abs() < 1e-15, "{s:?}");
        // Undamped average acceleration: K_eff = M + Δt²K/4, i.e. (4M/Δt² + K)·Δt²/4.
        assert_eq!(Scheme::new(0.0, 0.5, 0.0, 0.0).unwrap().effective(), (1.0, 0.0625));
        // Rayleigh damping enters both coefficients through γΔt = Δt/2 at α = 0.
        let (c_m, c_k) = Scheme::new(0.0, 0.5, 2.0, 0.25).unwrap().effective();
        assert_eq!((c_m, c_k), (1.0 + 0.25 * 2.0, 0.0625 + 0.25 * 0.25));
        // The HHT end: β = 4/9, γ = 5/6, and (1+α) = 2/3 in front of the stiffness.
        let (c_m, c_k) = Scheme::new(-1.0 / 3.0, 0.3, 1.0, 0.0).unwrap().effective();
        assert!((c_m - (1.0 + 2.0 / 3.0 * 5.0 / 6.0 * 0.3)).abs() < 1e-15);
        assert!((c_k - 2.0 / 3.0 * (4.0 / 9.0 * 0.09)).abs() < 1e-15);
    }

    #[test]
    fn out_of_range_knobs_are_schema_errors_naming_the_field() {
        for alpha in [0.1, -0.34, f64::NAN, f64::INFINITY] {
            let e = Scheme::new(alpha, 0.1, 0.0, 0.0).unwrap_err();
            assert_eq!((e.code, e.where_.as_deref()), (ErrorCode::Schema, Some("alpha")), "alpha {alpha}");
        }
        for (a, b, field) in [(-1.0, 0.0, "rayleighAlpha"), (0.0, f64::NAN, "rayleighBeta")] {
            let e = Scheme::new(-0.05, 0.1, a, b).unwrap_err();
            assert_eq!((e.code, e.where_.as_deref()), (ErrorCode::Schema, Some(field)));
        }
    }

    /// One scalar step of the α-method against the equation of motion it comes from,
    /// `m a₁ + (1+α)(c v₁ + k u₁) − α(c v₀ + k u₀) = (1+α) f₁ − α f₀`, for every knob at once.
    #[test]
    fn one_step_satisfies_the_hht_equation_of_motion() {
        let (m, k, f0, f1) = (2.0, 50.0, 3.0, 4.0);
        let (ar, br) = (0.3, 0.01);
        let c = ar * m + br * k;
        let s = Scheme::new(-0.1, 0.05, ar, br).unwrap();
        let (u0, v0) = (0.1, -0.2);
        let a0 = (f0 - c * v0 - k * u0) / m;
        let mut st = State::new(vec![u0], vec![v0], vec![a0]);
        predict(&s, &mut st);
        right_hand_side(&s, &scalar(m), &scalar(k), &[1.0], (1.0 + s.alpha) * f1 - s.alpha * f0, &mut st);
        let (c_m, c_k) = s.effective();
        st.a[0] = st.r[0] / (c_m * m + c_k * k);
        correct(&s, &mut st);
        let (u1, v1, a1) = (st.u[0], st.v[0], st.a[0]);
        let lhs = m * a1 + (1.0 + s.alpha) * (c * v1 + k * u1) - s.alpha * (c * v0 + k * u0);
        let rhs = (1.0 + s.alpha) * f1 - s.alpha * f0;
        assert!((lhs - rhs).abs() < 1e-12 * rhs.abs(), "{lhs} vs {rhs}");
        // And the Newmark relations hold between the corrected quantities.
        let dt = s.dt;
        assert!((u1 - (u0 + dt * v0 + dt * dt * ((0.5 - s.beta) * a0 + s.beta * a1))).abs() < 1e-15);
        assert!((v1 - (v0 + dt * ((1.0 - s.gamma) * a0 + s.gamma * a1))).abs() < 1e-14);
    }
}
