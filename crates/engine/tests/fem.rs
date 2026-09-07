//! Quadrature rules against exact monomial integrals, the Material Extension Point against
//! closed-form elasticity, the reference elements against their defining properties, and the
//! isoparametric solid against rigid modes, patch tests, closed-form totals and beam theory.
//! One binary: llvm-cov does not merge instantiations across binaries.

use std::collections::BTreeMap;
use std::f64::consts::PI;
use std::sync::atomic::{AtomicUsize, Ordering};

use femlab_engine::command::Formulation;
use femlab_engine::command::{CoupleKind, Field, SectionSpec, Solver, SweepSpacing};
use femlab_engine::fem::assembly::{
    assemble_stiffness, expand, pattern, pattern_coupled, reactions, reduce, resolve, Assembled, Csr, Pattern,
    ResolvedConstraints,
};
use femlab_engine::fem::checks;
use femlab_engine::fem::element::{
    element_for, min_det_j, Element, ElementCtx, FaceLoad, InverseMap, Iso, Material, TangentOut,
};
use femlab_engine::fem::heat::HeatLoad;
use femlab_engine::fem::loads::{assemble_loads, face_set_area, Load, LoadTotals};
use femlab_engine::fem::material::{
    builtin_law, check_batch, isotropic_d, plane_stress_condense, LinearElastic, MaterialBatch, MaterialLaw,
    MaterialOut, VOIGT,
};
use femlab_engine::fem::mpc::{self, Mpc, Row};
use femlab_engine::fem::problem::{Constraint, Coupling, PointMass, Problem};
use femlab_engine::fem::quadrature::{
    gauss_legendre, Rule, HEX_2X2X2, HEX_3X3X3, QUAD_2X2, QUAD_3X3, TET_1, TET_4, TRI_1, TRI_3,
};
use femlab_engine::fem::section::{properties, Section};
use femlab_engine::fem::shape::{
    centre_xi, dshape_of, face_dshape_of, face_rule_of, face_shape_of, in_reference, node_xi, rule_of, shape_of, Hex20,
    Hex8, Line2, Line3, Quad4, Quad4F, Quad8, Quad8F, RefElement, RefFace, Tet10, Tet4, Tri3, Tri3F, Tri6, Tri6F,
    LINE_2, LINE_3,
};
use femlab_engine::fem::state::GpState;
use femlab_engine::model::Idealisation;
use femlab_engine::par::Pool;
use femlab_engine::post::convergence::{observed_rate, richardson};
use femlab_engine::post::probe::{path, probe, probe_checked};
use femlab_engine::post::stress::{average_at_nodes, gp_to_nodes, principal, stress_gp, von_mises};
use femlab_engine::post::{extremes, reactions_per_constraint, FieldData, Per};
use femlab_engine::procedure::modal::assemble_mass;
use femlab_engine::procedure::nonlinear::{self, Converge as NlConverge, Options as NlOptions};
use femlab_engine::procedure::{self, heat, NonlinearControl, Step, StepResult};
use femlab_engine::solve::{cost_estimate, resolve_solver, solve, solver_name, SolveOptions};
use femlab_engine::units::{Length, Q};
use femlab_engine::{Error, ErrorCode, ResolvedSet, SetKind};
use femlab_engine::{OnProgress, Progress};
use femlab_geometry::mesh::{ElementKind, FaceKind};
use femlab_geometry::{annulus, mapped, perturb_interior, Curve, Mesh, QuadBlock, Structured};

#[path = "support/cost_allocator.rs"]
mod cost_allocator;

// ---------------------------------------------------------------- quadrature

fn integrate_monomial(r: &Rule, e: [i32; 3]) -> f64 {
    assert_eq!(r.points.len(), r.weights.len());
    r.points.iter().zip(r.weights).map(|(p, w)| w * p[0].powi(e[0]) * p[1].powi(e[1]) * p[2].powi(e[2])).sum()
}

fn factorial(n: i32) -> f64 {
    (1..=n).map(f64::from).product()
}

/// ∫ x^a over [-1, 1].
fn line_exact(a: i32) -> f64 {
    if a % 2 == 0 {
        2.0 / f64::from(a + 1)
    } else {
        0.0
    }
}

fn exact_cube(e: [i32; 3]) -> f64 {
    line_exact(e[0]) * line_exact(e[1]) * line_exact(e[2])
}

fn exact_quad(e: [i32; 3]) -> f64 {
    line_exact(e[0]) * line_exact(e[1])
}

/// ∫ x^a y^b z^c over the unit tetrahedron = a! b! c! / (a+b+c+3)!.
fn exact_tet(e: [i32; 3]) -> f64 {
    factorial(e[0]) * factorial(e[1]) * factorial(e[2]) / factorial(e[0] + e[1] + e[2] + 3)
}

/// ∫ x^a over [-1, 1], as an `Exact`.
fn exact_line(e: [i32; 3]) -> f64 {
    line_exact(e[0])
}

/// ∫ x^a y^b over the unit triangle = a! b! / (a+b+2)!.
fn exact_tri(e: [i32; 3]) -> f64 {
    factorial(e[0]) * factorial(e[1]) / factorial(e[0] + e[1] + 2)
}

/// The exact integral of `x^a y^b z^c` over one reference domain.
type Exact = fn([i32; 3]) -> f64;

/// Every monomial with each exponent ≤ `per_dir` (`total` = 0) or total degree ≤ `total`.
fn check_exact(r: &Rule, dims: usize, per_dir: i32, total: i32, exact: Exact) {
    let hi = per_dir.max(total);
    for a in 0..=hi {
        for b in 0..=(if dims > 1 { hi } else { 0 }) {
            for c in 0..=(if dims > 2 { hi } else { 0 }) {
                let e = [a, b, c];
                let admissible = if total > 0 { a + b + c <= total } else { e.iter().all(|&x| x <= per_dir) };
                if admissible {
                    let (got, want) = (integrate_monomial(r, e), exact(e));
                    assert!((got - want).abs() <= 1e-14, "{e:?}: got {got}, want {want}");
                }
            }
        }
    }
}

fn in_cube(p: &[f64; 3]) -> bool {
    p.iter().all(|x| x.abs() <= 1.0)
}

fn in_simplex(p: &[f64; 3]) -> bool {
    p.iter().all(|&x| x >= 0.0) && p.iter().sum::<f64>() <= 1.0
}

#[test]
fn gauss_legendre_tables_are_exact_and_clamped() {
    for n in 1..=3 {
        let gl = gauss_legendre(n);
        assert_eq!(gl.len(), n);
        for a in 0..=(2 * n as i32 - 1) {
            let got: f64 = gl.iter().map(|(x, w)| w * x.powi(a)).sum();
            assert!((got - line_exact(a)).abs() <= 1e-14, "n={n} a={a}: {got}");
        }
        // one degree beyond the rule is inexact (the rule is not accidentally higher order)
        let beyond: f64 = gl.iter().map(|(x, w)| w * x.powi(2 * n as i32)).sum();
        assert!((beyond - line_exact(2 * n as i32)).abs() > 1e-3, "n={n}");
    }
    assert_eq!(gauss_legendre(0), gauss_legendre(1));
    assert_eq!(gauss_legendre(7), gauss_legendre(3));
}

#[test]
fn tensor_rules_integrate_monomials_exactly() {
    let rules: [(&Rule, usize, i32, Exact); 4] = [
        (&QUAD_2X2, 2, 3, exact_quad),
        (&QUAD_3X3, 2, 5, exact_quad),
        (&HEX_2X2X2, 3, 3, exact_cube),
        (&HEX_3X3X3, 3, 5, exact_cube),
    ];
    for (r, dims, deg, exact) in rules {
        let measure = if dims == 2 { 4.0 } else { 8.0 };
        assert!((r.weights.iter().sum::<f64>() - measure).abs() <= 1e-14);
        assert!(r.points.iter().all(in_cube));
        assert!(r.points.iter().all(|p| dims == 3 || p[2] == 0.0));
        check_exact(r, dims, deg, 0, exact);
        // the next even degree is missed, in every direction
        for k in 0..dims {
            let mut e = [0; 3];
            e[k] = deg + 1;
            assert!((integrate_monomial(r, e) - exact(e)).abs() > 1e-3);
        }
    }
}

#[test]
fn simplex_rules_integrate_monomials_exactly() {
    for (r, deg) in [(&TET_1, 1), (&TET_4, 2)] {
        assert!((r.weights.iter().sum::<f64>() - 1.0 / 6.0).abs() <= 1e-16);
        assert!(r.points.iter().all(in_simplex));
        check_exact(r, 3, 0, deg, exact_tet);
        assert!((integrate_monomial(r, [deg + 1, 0, 0]) - exact_tet([deg + 1, 0, 0])).abs() > 1e-4);
    }
    for (r, deg) in [(&TRI_1, 1), (&TRI_3, 2)] {
        assert!((r.weights.iter().sum::<f64>() - 0.5).abs() <= 1e-16);
        assert!(r.points.iter().all(|p| in_simplex(p) && p[2] == 0.0));
        check_exact(r, 2, 0, deg, exact_tri);
        assert!((integrate_monomial(r, [deg + 1, 0, 0]) - exact_tri([deg + 1, 0, 0])).abs() > 1e-4);
    }
    // TET_4 is the symmetric rule: three points share b twice, the fourth is (b, b, b)
    let a: f64 = 0.585_410_196_624_968_5;
    let b: f64 = 0.138_196_601_125_010_5;
    assert!((a + 3.0 * b - 1.0).abs() <= 1e-16);
    assert_eq!(TET_4.points[3], [b, b, b]);
    assert_eq!(TET_4.points[0][0], a);
    assert_eq!(TRI_3.points[1][0], 2.0 / 3.0);
}

// ---------------------------------------------------------------- material

fn eval(law: &dyn MaterialLaw, props: &[f64], strain: &[f64]) -> Result<(Vec<f64>, Vec<f64>), Error> {
    let n = strain.len() / VOIGT;
    let zeros = vec![0.0; n * VOIGT];
    let mut stress = vec![0.0; n * VOIGT];
    let mut tangent = vec![0.0; n * VOIGT * VOIGT];
    let state_in = vec![0.0; n * law.n_state()];
    let mut state_out = vec![0.0; n * law.n_state()];
    let b = MaterialBatch { n, strain, dstrain: &zeros, temperature: &zeros[..n], dt: 0.0, props, state_in: &state_in };
    law.evaluate(b, MaterialOut { stress: &mut stress, tangent: &mut tangent, state_out: &mut state_out })?;
    Ok((stress, tangent))
}

/// `|a − b| ≤ tol · max(1, ‖b‖∞)` elementwise: relative to the largest expected entry.
fn close(a: &[f64], b: &[f64], tol: f64) {
    assert_eq!(a.len(), b.len());
    let scale = b.iter().fold(1.0, |m: f64, v| m.max(v.abs()));
    for (i, (x, y)) in a.iter().zip(b).enumerate() {
        assert!((x - y).abs() <= tol * scale, "[{i}]: {x} vs {y}");
    }
}

fn plane_stress_closed_form(e: f64, nu: f64) -> [f64; 9] {
    let k = e / (1.0 - nu * nu);
    [k, k * nu, 0.0, k * nu, k, 0.0, 0.0, 0.0, k * (1.0 - nu) / 2.0]
}

#[test]
fn isotropic_d_matches_lame_closed_form() {
    for (e, nu) in [(210e9, 0.3), (1.0, 0.0), (70e9, 0.49), (3.0e6, 0.25)] {
        let d = isotropic_d(e, nu);
        let lambda = e * nu / ((1.0 + nu) * (1.0 - 2.0 * nu));
        let mu = e / (2.0 * (1.0 + nu));
        for (i, row) in d.iter().enumerate() {
            for (j, &v) in row.iter().enumerate() {
                let want = match (i < 3, j < 3, i == j) {
                    (true, true, true) => lambda + 2.0 * mu,
                    (true, true, false) => lambda,
                    (false, false, true) => mu,
                    _ => 0.0,
                };
                assert!((v - want).abs() <= 1e-14 * (1.0 + want.abs()), "({i},{j}) {e} {nu}");
                assert_eq!(v.to_bits(), d[j][i].to_bits(), "symmetric");
            }
        }
        // ν = 0: D = E on the diagonal of the normal block, E/2 on the shear block
        if nu == 0.0 {
            assert_eq!(d[0][0], e);
            assert_eq!(d[0][1], 0.0);
            assert_eq!(d[3][3], e / 2.0);
        }
    }
}

#[test]
fn linear_elastic_metadata_and_builtin_lookup() {
    let law = LinearElastic;
    assert_eq!(law.id(), "linear-elastic");
    assert_eq!(law.n_props(), 2);
    assert_eq!(law.n_state(), 0);
    assert_eq!(law.prop_names(), ["E", "nu"]);
    assert_eq!(law.prop_names().len(), law.n_props());
    let b = builtin_law("linear-elastic").expect("built in");
    assert_eq!(b.id(), "linear-elastic");
    assert!(builtin_law("mooney-rivlin").is_none());
    assert!(builtin_law("").is_none());
}

#[test]
fn linear_elastic_stress_is_d_times_strain_and_tangent_is_d() {
    let (e, nu) = (200e9, 0.3);
    let eps = [1e-3, -2e-4, 3e-4, 5e-4, -1e-4, 2e-4];
    let (sig, tan) = eval(&LinearElastic, &[e, nu], &eps).expect("ok");
    let d = isotropic_d(e, nu);
    let flat: Vec<f64> = d.iter().flatten().copied().collect();
    assert_eq!(tan, flat);
    let want: Vec<f64> = (0..VOIGT).map(|i| (0..VOIGT).map(|j| d[i][j] * eps[j]).sum()).collect();
    close(&sig, &want, 1e-15);
    // uniaxial strain: σ₁₁ = (λ+2μ) ε, σ₂₂ = σ₃₃ = λ ε, no shear
    let (sig, _) = eval(&LinearElastic, &[e, nu], &[1e-3, 0.0, 0.0, 0.0, 0.0, 0.0]).expect("ok");
    close(&sig, &[d[0][0] * 1e-3, d[1][0] * 1e-3, d[2][0] * 1e-3, 0.0, 0.0, 0.0], 1e-15);
    // pure shear: σ₁₂ = μ γ
    let (sig, _) = eval(&LinearElastic, &[e, nu], &[0.0, 0.0, 0.0, 2e-3, 0.0, 0.0]).expect("ok");
    close(&sig, &[0.0, 0.0, 0.0, e / (2.0 * (1.0 + nu)) * 2e-3, 0.0, 0.0], 1e-15);
}

#[test]
fn batched_call_equals_single_calls_bitwise() {
    let props = [70e9, 0.33];
    let strain: Vec<f64> = (0..5 * VOIGT).map(|i| libm::sin(i as f64) * 1e-3).collect();
    let (sig, tan) = eval(&LinearElastic, &props, &strain).expect("ok");
    for p in 0..5 {
        let (s1, t1) = eval(&LinearElastic, &props, &strain[p * VOIGT..(p + 1) * VOIGT]).expect("ok");
        let bits = |v: &[f64]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&s1), bits(&sig[p * VOIGT..(p + 1) * VOIGT]));
        assert_eq!(bits(&t1), bits(&tan[p * 36..(p + 1) * 36]));
    }
    // and the plane-stress path
    let e2: Vec<f64> = (0..5 * 3).map(|i| libm::cos(i as f64) * 1e-3).collect();
    let (mut s, mut t) = (vec![0.0; 15], vec![0.0; 45]);
    plane_stress_condense(&LinearElastic, &props, &e2, &mut s, &mut t).expect("ok");
    for p in 0..5 {
        let (mut s1, mut t1) = (vec![0.0; 3], vec![0.0; 9]);
        plane_stress_condense(&LinearElastic, &props, &e2[p * 3..(p + 1) * 3], &mut s1, &mut t1).expect("ok");
        assert_eq!(s1, s[p * 3..(p + 1) * 3]);
        assert_eq!(t1, t[p * 9..(p + 1) * 9]);
    }
}

#[test]
fn plane_stress_condensation_matches_closed_form() {
    for (e, nu) in [(210e9, 0.3), (1.0, 0.0), (70e9, 0.49), (1.0, 0.25)] {
        let eps = [1e-3, -4e-4, 6e-4];
        let (mut s, mut t) = (vec![0.0; 3], vec![0.0; 9]);
        plane_stress_condense(&LinearElastic, &[e, nu], &eps, &mut s, &mut t).expect("ok");
        let d = plane_stress_closed_form(e, nu);
        close(&t, &d, 1e-14);
        let want: Vec<f64> = (0..3).map(|i| (0..3).map(|j| d[i * 3 + j] * eps[j]).sum()).collect();
        close(&s, &want, 1e-14);
        // uniaxial stress: ε₂₂ = −ν ε₁₁ gives σ₁₁ = E ε₁₁ and σ₂₂ = 0
        let (mut s, mut t) = (vec![0.0; 3], vec![0.0; 9]);
        plane_stress_condense(&LinearElastic, &[e, nu], &[1e-3, -nu * 1e-3, 0.0], &mut s, &mut t).expect("ok");
        close(&s, &[e * 1e-3, 0.0, 0.0], 1e-14);
    }
    // zero strain converges immediately with zero stress
    let (mut s, mut t) = (vec![0.0; 3], vec![0.0; 9]);
    plane_stress_condense(&LinearElastic, &[1.0, 0.3], &[0.0; 3], &mut s, &mut t).expect("ok");
    assert_eq!(s, [0.0; 3]);
    close(&t, &plane_stress_closed_form(1.0, 0.3), 1e-15);
}

/// Linear elastic plus a cubic σ₃₃ term, with one call counted per `evaluate`: Newton needs
/// more than one step, so the iteration cap is what stops it. Fails on call `fail_on` (0: never).
struct Cubic {
    calls: AtomicUsize,
    fail_on: usize,
}

fn cubic(fail_on: usize) -> Cubic {
    Cubic { calls: AtomicUsize::new(0), fail_on }
}

impl MaterialLaw for Cubic {
    fn id(&self) -> &str {
        "cubic-zz"
    }
    fn n_props(&self) -> usize {
        3
    }
    fn n_state(&self) -> usize {
        1
    }
    fn prop_names(&self) -> &[&str] {
        &["E", "nu", "k"]
    }
    fn evaluate(&self, b: MaterialBatch<'_>, out: MaterialOut<'_>) -> Result<(), Error> {
        if self.calls.fetch_add(1, Ordering::SeqCst) + 1 == self.fail_on {
            return Err(Error::new(ErrorCode::MaterialProps, "asked to fail").at("material.test"));
        }
        check_batch(self, &b, &out)?;
        let (k, n) = (b.props[2], b.n);
        LinearElastic.evaluate(
            MaterialBatch { props: &b.props[..2], state_in: &[], ..b },
            MaterialOut { stress: &mut out.stress[..], tangent: &mut out.tangent[..], state_out: &mut [] },
        )?;
        for p in 0..n {
            let ezz = b.strain[p * VOIGT + 2];
            out.stress[p * VOIGT + 2] += k * ezz * ezz * ezz;
            out.tangent[p * 36 + 2 * VOIGT + 2] += 3.0 * k * ezz * ezz;
            out.state_out[p] = b.state_in[p] + 1.0;
        }
        Ok(())
    }
}

#[test]
fn plane_stress_newton_stops_after_three_iterations_and_after_one_for_linear() {
    let counted = cubic(0);
    let (mut s, mut t) = (vec![0.0; 6], vec![0.0; 18]);
    plane_stress_condense(&counted, &[1.0, 0.3, 50.0], &[0.1, 0.0, 0.0, 0.2, 0.1, 0.0], &mut s, &mut t).expect("ok");
    assert_eq!(counted.calls.load(Ordering::SeqCst), 4, "first evaluation + 3 Newton steps");
    // the answer still moves towards σ₃₃ = 0: εzz only enters σ₁₁ through λ, so σ₁₁ stays bounded
    assert!(s[0].is_finite() && s[0] > 0.0);
    let linear_counter = cubic(0);
    let (mut s, mut t) = (vec![0.0; 3], vec![0.0; 9]);
    plane_stress_condense(&linear_counter, &[1.0, 0.3, 0.0], &[1e-3, 0.0, 0.0], &mut s, &mut t).expect("ok");
    assert_eq!(linear_counter.calls.load(Ordering::SeqCst), 2, "k = 0 is linear: one Newton step");
    close(&t, &plane_stress_closed_form(1.0, 0.3), 1e-14);
}

fn where_of(r: Result<(), Error>) -> String {
    let e = r.expect_err("should fail");
    assert_eq!(e.code, ErrorCode::MaterialProps);
    e.where_.expect("where")
}

#[test]
fn every_length_mismatch_is_a_material_props_error() {
    let law = LinearElastic;
    let good = [2usize, 6, 6, 1, 0, 6, 36, 0];
    let names = ["props", "strain", "dstrain", "temperature", "state_in", "stress", "tangent", "state_out"];
    for (k, name) in names.iter().enumerate() {
        let mut len = good;
        len[k] += 1;
        let (props, strain, dstrain, temp, state_in) =
            (vec![1.0; len[0]], vec![0.0; len[1]], vec![0.0; len[2]], vec![0.0; len[3]], vec![0.0; len[4]]);
        let (mut stress, mut tangent, mut state_out) = (vec![0.0; len[5]], vec![0.0; len[6]], vec![0.0; len[7]]);
        let b = MaterialBatch {
            n: 1,
            strain: &strain,
            dstrain: &dstrain,
            temperature: &temp,
            dt: 0.0,
            props: &props,
            state_in: &state_in,
        };
        let out = MaterialOut { stress: &mut stress, tangent: &mut tangent, state_out: &mut state_out };
        let e = law.evaluate(b, out).expect_err("should fail");
        assert_eq!(e.code, ErrorCode::MaterialProps);
        assert_eq!(e.where_.as_deref(), Some(format!("material.{name}").as_str()));
        assert!(e.cause.starts_with(name), "{}", e.cause);
    }
    // the good lengths pass
    assert!(eval(&LinearElastic, &[1.0, 0.3], &[0.0; 6]).is_ok());
    // plane stress: its own slices, and the law's props error propagates
    let (mut s3, mut t9) = (vec![0.0; 3], vec![0.0; 9]);
    assert_eq!(where_of(plane_stress_condense(&law, &[1.0, 0.3], &[0.0; 4], &mut s3, &mut t9)), "material.strain");
    assert_eq!(
        where_of(plane_stress_condense(&law, &[1.0, 0.3], &[0.0; 3], &mut [0.0; 2], &mut t9)),
        "material.stress"
    );
    assert_eq!(
        where_of(plane_stress_condense(&law, &[1.0, 0.3], &[0.0; 3], &mut s3, &mut [0.0; 8])),
        "material.tangent"
    );
    assert_eq!(where_of(plane_stress_condense(&law, &[1.0], &[0.0; 3], &mut s3, &mut t9)), "material.props");
    // a failing law inside the Newton loop propagates too: Cubic rejects two props
    let bad = cubic(0);
    assert_eq!(
        where_of(plane_stress_condense(&bad, &[1.0, 0.3], &[1e-3, 0.0, 0.0], &mut s3, &mut t9)),
        "material.props"
    );
    // and a failure on the second call, inside the Newton loop
    let late = cubic(2);
    assert_eq!(
        where_of(plane_stress_condense(&late, &[1.0, 0.3, 5.0], &[1e-3, 0.0, 0.0], &mut s3, &mut t9)),
        "material.test"
    );
    assert_eq!(late.calls.load(Ordering::SeqCst), 2);
}

fn assert_send_sync<T: Send + Sync>() {}

#[test]
fn laws_are_send_and_sync() {
    assert_send_sync::<LinearElastic>();
    assert_send_sync::<&'static dyn MaterialLaw>();
    assert_send_sync::<Cubic>();
}

// ---------------------------------------------------------------- shape functions

/// Deterministic linear congruential generator: the shape-function property tests want random
/// points but a reproducible failure.
struct Lcg(u64);

impl Lcg {
    fn unit(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
}

const ALL_KINDS: [ElementKind; 8] = [
    ElementKind::Hex8,
    ElementKind::Hex20,
    ElementKind::Tet4,
    ElementKind::Tet10,
    ElementKind::Quad4,
    ElementKind::Quad8,
    ElementKind::Tri3,
    ElementKind::Tri6,
];

const ALL_FACE_KINDS: [FaceKind; 6] =
    [FaceKind::Quad4, FaceKind::Quad8, FaceKind::Tri3, FaceKind::Tri6, FaceKind::Line2, FaceKind::Line3];

/// A point inside the reference domain: uniform on the cube, and the sorted-uniform
/// construction (which is uniform on the simplex) for tetrahedra and triangles.
fn random_xi(kind: ElementKind, r: &mut Lcg) -> [f64; 3] {
    let dim = kind.dim();
    let mut xi = [0.0; 3];
    if in_reference(kind, [1.0, 1.0, 1.0], 0.0) {
        for x in xi.iter_mut().take(dim) {
            *x = 2.0 * r.unit() - 1.0;
        }
        return xi;
    }
    let mut u = [r.unit(), r.unit(), r.unit()];
    u.sort_by(f64::total_cmp);
    for (k, x) in xi.iter_mut().enumerate().take(dim) {
        *x = u[k] - if k == 0 { 0.0 } else { u[k - 1] };
    }
    xi
}

/// The centre of a face parent's own domain.
fn face_centre(kind: FaceKind) -> [f64; 2] {
    match kind {
        FaceKind::Tri3 | FaceKind::Tri6 => [1.0 / 3.0, 1.0 / 3.0],
        _ => [0.0, 0.0],
    }
}

/// Reference coordinates of a face parent's nodes, in `face_nodes` order.
fn face_node_s(kind: FaceKind) -> Vec<[f64; 2]> {
    let flat = |k: ElementKind| node_xi(k).iter().map(|p| [p[0], p[1]]).collect::<Vec<_>>();
    match kind {
        FaceKind::Quad4 => flat(ElementKind::Quad4),
        FaceKind::Quad8 => flat(ElementKind::Quad8),
        FaceKind::Tri3 => flat(ElementKind::Tri3),
        FaceKind::Tri6 => flat(ElementKind::Tri6),
        FaceKind::Line2 => vec![[-1.0, 0.0], [1.0, 0.0]],
        FaceKind::Line3 => vec![[-1.0, 0.0], [1.0, 0.0], [0.0, 0.0]],
    }
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn sub3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn norm3(a: [f64; 3]) -> f64 {
    dot3(a, a).sqrt()
}

#[test]
fn shape_functions_are_a_partition_of_unity_with_vanishing_derivative_sums() {
    let mut rng = Lcg(0x5eed_1234);
    for kind in ALL_KINDS {
        let nn = kind.n_nodes();
        let (mut n, mut dn) = (vec![0.0; nn], vec![[0.0; 3]; nn]);
        for _ in 0..32 {
            let xi = random_xi(kind, &mut rng);
            assert!(in_reference(kind, xi, 1e-12), "{kind:?} {xi:?}");
            shape_of(kind, xi, &mut n);
            assert!((n.iter().sum::<f64>() - 1.0).abs() <= 1e-14, "{kind:?} {xi:?} {n:?}");
            dshape_of(kind, xi, &mut dn);
            for j in 0..3 {
                let s: f64 = dn.iter().map(|d| d[j]).sum();
                assert!(s.abs() <= 1e-13, "{kind:?} d{j} {s}");
            }
            // the third parametric direction is unused in 2D
            for d in &dn {
                assert!(kind.dim() == 3 || d[2] == 0.0);
            }
        }
    }
}

#[test]
fn shape_functions_are_the_kronecker_delta_at_the_nodes() {
    for kind in ALL_KINDS {
        let x = node_xi(kind);
        assert_eq!(x.len(), kind.n_nodes());
        // mid-edge node n_corners + i is the midpoint of edges()[i]
        for (i, e) in kind.edges()[..kind.n_nodes() - kind.n_corners()].iter().enumerate() {
            let (a, b) = (x[e[0] as usize], x[e[1] as usize]);
            for k in 0..3 {
                assert_eq!(x[kind.n_corners() + i][k], 0.5 * (a[k] + b[k]));
            }
        }
        let mut n = vec![0.0; kind.n_nodes()];
        for (a, &p) in x.iter().enumerate() {
            shape_of(kind, p, &mut n);
            for (b, &v) in n.iter().enumerate() {
                let want = f64::from(u8::from(a == b));
                assert!((v - want).abs() <= 1e-14, "{kind:?} N{b}(node {a}) = {v}");
            }
        }
        // and the centre is the mean of the corners
        let c = centre_xi(kind);
        for k in 0..3 {
            let mean: f64 = x[..kind.n_corners()].iter().map(|p| p[k]).sum::<f64>() / kind.n_corners() as f64;
            assert!((c[k] - mean).abs() <= 1e-15);
        }
    }
}

#[test]
fn each_kind_gets_the_planned_rule_and_it_is_exact_to_that_degree() {
    let plan: [(ElementKind, usize, i32, i32, Exact, f64); 8] = [
        (ElementKind::Hex8, 8, 3, 0, exact_cube, 8.0),
        (ElementKind::Hex20, 27, 5, 0, exact_cube, 8.0),
        (ElementKind::Tet4, 1, 0, 1, exact_tet, 1.0 / 6.0),
        (ElementKind::Tet10, 4, 0, 2, exact_tet, 1.0 / 6.0),
        (ElementKind::Quad4, 4, 3, 0, exact_quad, 4.0),
        (ElementKind::Quad8, 9, 5, 0, exact_quad, 4.0),
        (ElementKind::Tri3, 1, 0, 1, exact_tri, 0.5),
        (ElementKind::Tri6, 3, 0, 2, exact_tri, 0.5),
    ];
    for (kind, n, per_dir, total, exact, measure) in plan {
        let r = rule_of(kind);
        assert_eq!(r.points.len(), n, "{kind:?}");
        assert_eq!(r.weights.len(), n, "{kind:?}");
        assert!((r.weights.iter().sum::<f64>() - measure).abs() <= 1e-14, "{kind:?}");
        check_exact(&r, kind.dim(), per_dir, total, exact);
    }
    // face parents: the same rules, plus the two line rules built from Gauss–Legendre
    let faces: [(FaceKind, usize, f64); 6] = [
        (FaceKind::Quad4, 4, 4.0),
        (FaceKind::Quad8, 9, 4.0),
        (FaceKind::Tri3, 1, 0.5),
        (FaceKind::Tri6, 3, 0.5),
        (FaceKind::Line2, 2, 2.0),
        (FaceKind::Line3, 3, 2.0),
    ];
    for (kind, n, measure) in faces {
        let r = face_rule_of(kind);
        assert_eq!(r.points.len(), n, "{kind:?}");
        assert!((r.weights.iter().sum::<f64>() - measure).abs() <= 1e-14, "{kind:?}");
    }
    for (r, n) in [(&LINE_2, 2usize), (&LINE_3, 3)] {
        for (i, (x, w)) in gauss_legendre(n).iter().enumerate() {
            assert_eq!(r.points[i], [*x, 0.0, 0.0]);
            assert_eq!(r.weights[i], *w);
        }
        check_exact(r, 1, 2 * n as i32 - 1, 0, exact_line);
    }
}

#[test]
fn face_shape_functions_are_a_partition_of_unity_and_kronecker() {
    let mut rng = Lcg(0xf00d);
    for kind in ALL_FACE_KINDS {
        let nn = kind.n_nodes();
        let (mut n, mut dn) = (vec![0.0; nn], vec![[0.0; 2]; nn]);
        for (a, &p) in face_node_s(kind).iter().enumerate() {
            face_shape_of(kind, p, &mut n);
            assert_eq!(n.len(), nn);
            for (b, &v) in n.iter().enumerate() {
                let want = f64::from(u8::from(a == b));
                assert!((v - want).abs() <= 1e-14, "{kind:?} N{b}(node {a}) = {v}");
            }
        }
        for _ in 0..16 {
            let raw = [2.0 * rng.unit() - 1.0, 2.0 * rng.unit() - 1.0];
            let s = if kind.n_corners() == 3 { [raw[0].abs() * 0.4, raw[1].abs() * 0.4] } else { raw };
            face_shape_of(kind, s, &mut n);
            assert!((n.iter().sum::<f64>() - 1.0).abs() <= 1e-14, "{kind:?} {s:?}");
            face_dshape_of(kind, s, &mut dn);
            for j in 0..2 {
                assert!(dn.iter().map(|d| d[j]).sum::<f64>().abs() <= 1e-13, "{kind:?} d{j}");
            }
            // the line parents have no second direction
            assert!(kind.n_corners() > 2 || dn.iter().all(|d| d[1] == 0.0));
        }
    }
}

#[test]
fn face_normals_point_away_from_the_element_centroid() {
    for kind in ALL_KINDS {
        let xi = node_xi(kind);
        let mut centroid = [0.0; 3];
        for p in &xi {
            for k in 0..3 {
                centroid[k] += p[k] / xi.len() as f64;
            }
        }
        let fk = kind.face_kind();
        let (mut n, mut dn) = (vec![0.0; fk.n_nodes()], vec![[0.0; 2]; fk.n_nodes()]);
        for f in 0..kind.n_faces() {
            let nodes = kind.face_nodes(f);
            assert_eq!(nodes.len(), fk.n_nodes());
            let s = face_centre(fk);
            face_shape_of(fk, s, &mut n);
            face_dshape_of(fk, s, &mut dn);
            let (mut x, mut t) = ([0.0; 3], [[0.0; 3]; 2]);
            for (i, &l) in nodes.iter().enumerate() {
                let p = xi[l as usize];
                for k in 0..3 {
                    x[k] += n[i] * p[k];
                    t[0][k] += dn[i][0] * p[k];
                    t[1][k] += dn[i][1] * p[k];
                }
            }
            let nvec = if kind.dim() == 3 { cross(t[0], t[1]) } else { [t[0][1], -t[0][0], 0.0] };
            let out = sub3(x, centroid);
            let cos = dot3(nvec, out) / (norm3(nvec) * norm3(out));
            assert!(cos > 0.3, "{kind:?} face {f}: cos {cos}");
        }
    }
}

fn check_ref_element<R: RefElement>() {
    let kind = R::KIND;
    assert_eq!(R::N, kind.n_nodes());
    assert_eq!(R::DIM, kind.dim());
    let (a, b) = (R::rule(), rule_of(kind));
    assert_eq!(a.points, b.points);
    assert_eq!(a.weights, b.weights);
    let xi = [0.11, 0.22, 0.13];
    let (mut n1, mut n2) = (vec![0.0; R::N], vec![0.0; R::N]);
    R::shape(xi, &mut n1);
    shape_of(kind, xi, &mut n2);
    assert_eq!(n1, n2);
    let (mut d1, mut d2) = (vec![[0.0; 3]; R::N], vec![[0.0; 3]; R::N]);
    R::dshape(xi, &mut d1);
    dshape_of(kind, xi, &mut d2);
    assert_eq!(d1, d2);
}

fn check_ref_face<F: RefFace>() {
    let kind = F::KIND;
    assert_eq!(F::N, kind.n_nodes());
    let (a, b) = (F::rule(), face_rule_of(kind));
    assert_eq!(a.points, b.points);
    assert_eq!(a.weights, b.weights);
    let s = [0.17, 0.23];
    let (mut n1, mut n2) = (vec![0.0; F::N], vec![0.0; F::N]);
    F::shape(s, &mut n1);
    face_shape_of(kind, s, &mut n2);
    assert_eq!(n1, n2);
    let (mut d1, mut d2) = (vec![[0.0; 2]; F::N], vec![[0.0; 2]; F::N]);
    F::dshape(s, &mut d1);
    face_dshape_of(kind, s, &mut d2);
    assert_eq!(d1, d2);
}

#[test]
fn the_typed_reference_elements_are_the_enum_dispatch() {
    check_ref_element::<Hex8>();
    check_ref_element::<Hex20>();
    check_ref_element::<Tet4>();
    check_ref_element::<Tet10>();
    check_ref_element::<Quad4>();
    check_ref_element::<Quad8>();
    check_ref_element::<Tri3>();
    check_ref_element::<Tri6>();
    check_ref_face::<Quad4F>();
    check_ref_face::<Quad8F>();
    check_ref_face::<Tri3F>();
    check_ref_face::<Tri6F>();
    check_ref_face::<Line2>();
    check_ref_face::<Line3>();
}

// ---------------------------------------------------------------- elements

const YOUNG: f64 = 210e9;
const POISSON: f64 = 0.3;
const DENSITY: f64 = 7800.0;
const EXPANSION: f64 = 1.2e-5;
const THICKNESS: f64 = 0.7;
const PRESSURE: f64 = 2.5e5;

fn steel() -> Material {
    Material {
        law: builtin_law("linear-elastic").expect("built in"),
        props: vec![YOUNG, POISSON],
        rho: DENSITY,
        alpha: EXPANSION,
        k: 45.0,
        cp: 460.0,
    }
}

fn ctx<'a>(coords: &'a [f64], mat: &'a Material, id: Idealisation, form: Formulation) -> ElementCtx<'a> {
    ElementCtx {
        coords,
        material: mat,
        section: None,
        idealisation: id,
        formulation: form,
        temperature: None,
        t_ref: 0.0,
    }
}

/// Every idealisation that applies to a kind: 3D solids are 3D, sheets are all three 2D ones.
fn idealisations(kind: ElementKind) -> Vec<Idealisation> {
    if kind.dim() == 3 {
        vec![Idealisation::Solid3d]
    } else {
        vec![Idealisation::PlaneStress { thickness: THICKNESS }, Idealisation::PlaneStrain, Idealisation::Axisymmetric]
    }
}

/// The idealisation's weight on a measure: thickness, 1, or Pappus' `2π r̄`.
fn weighted(id: &Idealisation, base: f64, rbar: f64) -> f64 {
    match id {
        Idealisation::Solid3d | Idealisation::PlaneStrain => base,
        Idealisation::PlaneStress { thickness } => base * thickness,
        Idealisation::Axisymmetric => 2.0 * std::f64::consts::PI * rbar * base,
    }
}

fn map_nodes(kind: ElementKind, f: fn([f64; 3]) -> [f64; 3]) -> Vec<f64> {
    node_xi(kind).iter().flat_map(|&p| f(p)).collect()
}

/// A mildly non-affine map every kind reproduces exactly (its only non-linear terms are `ab`
/// and `bc`), with a positive Jacobian and `r > 0` everywhere, so one geometry serves as the
/// distorted element for all eight kinds and all four idealisations.
fn distortion(p: [f64; 3]) -> [f64; 3] {
    let [a, b, c] = p;
    [
        2.0 + 1.3 * a + 0.2 * b + 0.1 * c + 0.05 * a * b,
        1.0 + 0.15 * a + 1.1 * b + 0.2 * c + 0.04 * b * c,
        0.5 + 0.1 * a + 0.05 * b + 0.9 * c,
    ]
}

fn distorted(kind: ElementKind) -> Vec<f64> {
    let mut v = map_nodes(kind, distortion);
    if kind.dim() == 2 {
        for z in v.iter_mut().skip(2).step_by(3) {
            *z = 0.0;
        }
    }
    v
}

fn box_map(p: [f64; 3]) -> [f64; 3] {
    [2.0 + p[0], 1.0 + p[1], 2.0 * p[2]]
}

fn simplex_map(p: [f64; 3]) -> [f64; 3] {
    [1.0 + 2.0 * p[0], 2.0 * p[1], 3.0 * p[2]]
}

/// A straight-sided element whose measure and area centroid are known in closed form:
/// `(coords, volume or area, centroid r)`. Every map here is affine, so every quadrature rule
/// integrates the measure exactly and the totals are checkable to roundoff.
fn simple(kind: ElementKind) -> (Vec<f64>, f64, f64) {
    if in_reference(kind, [1.0, 1.0, 1.0], 0.0) {
        // r ∈ [1,3], y ∈ [0,2], z ∈ [-2,2]
        let base = if kind.dim() == 3 { 16.0 } else { 4.0 };
        (map_nodes(kind, box_map), base, 2.0)
    } else {
        // corners (1,0,0), (3,0,0), (1,2,0), (1,0,3)
        (map_nodes(kind, simplex_map), 2.0, 5.0 / 3.0)
    }
}

/// The same element mirrored in x: every Jacobian determinant flips sign.
fn folded(kind: ElementKind) -> Vec<f64> {
    let mut v = distorted(kind);
    for x in v.iter_mut().step_by(3) {
        *x = -*x;
    }
    v
}

fn mat_vec(a: &[f64], n: usize, x: &[f64]) -> Vec<f64> {
    (0..n).map(|i| (0..n).map(|j| a[i * n + j] * x[j]).sum()).collect()
}

fn inf_norm(v: &[f64]) -> f64 {
    v.iter().fold(0.0f64, |m, x| m.max(x.abs()))
}

/// `‖A‖∞`, the largest absolute row sum.
fn row_sum_norm(a: &[f64], n: usize) -> f64 {
    (0..n).map(|i| a[i * n..(i + 1) * n].iter().map(|v| v.abs()).sum::<f64>()).fold(0.0f64, f64::max)
}

/// Eigenvalues of a symmetric matrix by cyclic Jacobi. The rotation angle comes from `atan2`,
/// so an already-zero off-diagonal rotates by zero instead of needing a guard.
fn jacobi_eigenvalues(a: &[f64], n: usize) -> Vec<f64> {
    let mut m = a.to_vec();
    for _ in 0..15 {
        for p in 0..n {
            for q in p + 1..n {
                let phi = 0.5 * libm::atan2(2.0 * m[p * n + q], m[q * n + q] - m[p * n + p]);
                let (c, s) = (libm::cos(phi), libm::sin(phi));
                for k in 0..n {
                    let (kp, kq) = (m[k * n + p], m[k * n + q]);
                    m[k * n + p] = c * kp - s * kq;
                    m[k * n + q] = s * kp + c * kq;
                }
                for k in 0..n {
                    let (pk, qk) = (m[p * n + k], m[q * n + k]);
                    m[p * n + k] = c * pk - s * qk;
                    m[q * n + k] = s * pk + c * qk;
                }
            }
        }
    }
    (0..n).map(|i| m[i * n + i]).collect()
}

/// `A x = b` for a symmetric positive definite `A`, by Cholesky.
fn spd_solve(a: &[f64], n: usize, b: &[f64]) -> Vec<f64> {
    let mut l = a.to_vec();
    for i in 0..n {
        for j in 0..=i {
            let mut s = l[i * n + j];
            for k in 0..j {
                s -= l[i * n + k] * l[j * n + k];
            }
            l[i * n + j] = if i == j { s.sqrt() } else { s / l[j * n + j] };
        }
    }
    let mut x = b.to_vec();
    for i in 0..n {
        let mut s = x[i];
        for k in 0..i {
            s -= l[i * n + k] * x[k];
        }
        x[i] = s / l[i * n + i];
    }
    for i in (0..n).rev() {
        let mut s = x[i];
        for k in i + 1..n {
            s -= l[k * n + i] * x[k];
        }
        x[i] = s / l[i * n + i];
    }
    x
}

/// The nodal vector of a displacement field.
fn nodal_field(kind: ElementKind, coords: &[f64], f: &dyn Fn([f64; 3]) -> [f64; 3]) -> Vec<f64> {
    let (nn, dim) = (kind.n_nodes(), kind.dim());
    let mut v = vec![0.0; nn * dim];
    for a in 0..nn {
        let d = f([coords[3 * a], coords[3 * a + 1], coords[3 * a + 2]]);
        for i in 0..dim {
            v[dim * a + i] = d[i];
        }
    }
    v
}

/// The rigid-body modes an idealisation has: six in 3D, three in plane, and only the axial
/// translation for an axisymmetric body (a radial one strains the hoop direction).
fn rigid_modes(kind: ElementKind, id: &Idealisation, coords: &[f64]) -> Vec<Vec<f64>> {
    let m = |f: &dyn Fn([f64; 3]) -> [f64; 3]| nodal_field(kind, coords, f);
    if let Idealisation::Axisymmetric = id {
        return vec![m(&|_x: [f64; 3]| [0.0, 1.0, 0.0])];
    }
    let mut v = vec![
        m(&|_x: [f64; 3]| [1.0, 0.0, 0.0]),
        m(&|_x: [f64; 3]| [0.0, 1.0, 0.0]),
        m(&|x: [f64; 3]| [-x[1], x[0], 0.0]),
    ];
    if kind.dim() == 3 {
        v.push(m(&|_x: [f64; 3]| [0.0, 0.0, 1.0]));
        v.push(m(&|x: [f64; 3]| [-x[2], 0.0, x[0]]));
        v.push(m(&|x: [f64; 3]| [0.0, -x[2], x[1]]));
    }
    v
}

/// The constant-strain states an idealisation can hold, as Voigt strain vectors. Axisymmetric
/// gets `ε_rr = ε_θθ` (the only constant hoop strain a radial field can give), `ε_zz` and `γ_rz`.
fn patch_modes(id: &Idealisation) -> Vec<[f64; VOIGT]> {
    let unit = |i: usize| {
        let mut e = [0.0; VOIGT];
        e[i] = 1e-3;
        e
    };
    match id {
        Idealisation::Solid3d => (0..VOIGT).map(unit).collect(),
        Idealisation::Axisymmetric => {
            let mut rr = unit(0);
            rr[2] = 1e-3;
            vec![rr, unit(1), unit(3)]
        }
        _ => vec![unit(0), unit(1), unit(3)],
    }
}

/// `u = ε · x` at one point for one constant-strain mode (engineering shear halved).
fn patch_u(id: &Idealisation, three: bool, e: &[f64; VOIGT], x: [f64; 3]) -> [f64; 3] {
    if three {
        [
            e[0] * x[0] + 0.5 * e[3] * x[1] + 0.5 * e[4] * x[2],
            0.5 * e[3] * x[0] + e[1] * x[1] + 0.5 * e[5] * x[2],
            0.5 * e[4] * x[0] + 0.5 * e[5] * x[1] + e[2] * x[2],
        ]
    } else if let Idealisation::Axisymmetric = id {
        [e[0] * x[0], e[1] * x[1] + e[3] * x[0], 0.0]
    } else {
        [e[0] * x[0] + 0.5 * e[3] * x[1], 0.5 * e[3] * x[0] + e[1] * x[1], 0.0]
    }
}

/// `u = ε · x` on one element's nodes.
fn patch_displacement(kind: ElementKind, id: &Idealisation, coords: &[f64], e: &[f64; VOIGT]) -> Vec<f64> {
    let three = kind.dim() == 3;
    nodal_field(kind, coords, &|x: [f64; 3]| patch_u(id, three, e, x))
}

/// The stress a constant strain produces: the 3D law, or the condensed plane-stress law.
fn expected_stress(id: &Idealisation, e: &[f64; VOIGT]) -> [f64; VOIGT] {
    let mut s = [0.0; VOIGT];
    if let Idealisation::PlaneStress { .. } = id {
        let d = plane_stress_closed_form(YOUNG, POISSON);
        let p = [e[0], e[1], e[3]];
        for (a, &i) in [0usize, 1, 3].iter().enumerate() {
            s[i] = (0..3).map(|b| d[a * 3 + b] * p[b]).sum();
        }
        return s;
    }
    let d = isotropic_d(YOUNG, POISSON);
    for (i, si) in s.iter_mut().enumerate() {
        *si = (0..VOIGT).map(|j| d[i][j] * e[j]).sum();
    }
    s
}

/// Area, outward unit normal and area-centroid radius of one face of a straight-sided element.
fn face_geometry(kind: ElementKind, coords: &[f64], f: usize) -> (f64, [f64; 3], f64) {
    let nodes = kind.face_nodes(f);
    let nc = kind.face_kind().n_corners();
    let p = |i: usize| {
        let n = nodes[i] as usize;
        [coords[3 * n], coords[3 * n + 1], coords[3 * n + 2]]
    };
    let rbar = (0..nc).map(|i| p(i)[0]).sum::<f64>() / nc as f64;
    if kind.dim() == 3 {
        let mut a = [0.0; 3];
        for t in 1..nc - 1 {
            let c = cross(sub3(p(t), p(0)), sub3(p(t + 1), p(0)));
            for k in 0..3 {
                a[k] += 0.5 * c[k];
            }
        }
        let m = norm3(a);
        return (m, [a[0] / m, a[1] / m, a[2] / m], rbar);
    }
    let t = sub3(p(1), p(0));
    let m = norm3(t);
    (m, [t[1] / m, -t[0] / m, 0.0], rbar)
}

#[test]
fn element_stiffness_is_symmetric_and_annihilates_the_rigid_modes() {
    let mat = steel();
    for kind in ALL_KINDS {
        let el = element_for(kind);
        assert_eq!(el.kind(), kind);
        let n = kind.n_nodes() * kind.dim();
        assert_eq!(el.n_dof(), n);
        assert_eq!(el.n_gp(), rule_of(kind).points.len());
        let coords = distorted(kind);
        for id in idealisations(kind) {
            for form in [Formulation::Full, Formulation::IncompatibleModes] {
                let c = ctx(&coords, &mat, id.clone(), form);
                let mut k = vec![0.0; n * n];
                let det = el.stiffness(&c, &mut k).expect("a valid element");
                assert!(det > 0.0, "{kind:?} min det J {det}");
                let scale = row_sum_norm(&k, n);
                for i in 0..n {
                    for j in 0..n {
                        assert!((k[i * n + j] - k[j * n + i]).abs() <= 1e-12 * scale, "{kind:?} ({i},{j})");
                    }
                }
                for r in rigid_modes(kind, &id, &coords) {
                    let res = inf_norm(&mat_vec(&k, n, &r));
                    assert!(res <= 1e-12 * scale * inf_norm(&r), "{kind:?} {id:?} {form:?}: {res}");
                }
            }
        }
    }
}

#[test]
fn a_single_hex8_has_six_rigid_modes_and_eighteen_stiff_ones() {
    let mat = steel();
    let coords = distorted(ElementKind::Hex8);
    let el = element_for(ElementKind::Hex8);
    for form in [Formulation::Full, Formulation::IncompatibleModes] {
        let c = ctx(&coords, &mat, Idealisation::Solid3d, form);
        let mut k = vec![0.0; 24 * 24];
        el.stiffness(&c, &mut k).expect("ok");
        let mut ev = jacobi_eigenvalues(&k, 24);
        ev.sort_by(f64::total_cmp);
        let top = ev[23];
        assert!(top > 0.0);
        assert_eq!(ev.iter().filter(|v| v.abs() <= 1e-10 * top).count(), 6, "{form:?} {ev:?}");
        assert_eq!(ev.iter().filter(|&&v| v > 1e-8 * top).count(), 18, "{form:?} {ev:?}");
    }
}

#[test]
fn one_distorted_element_reproduces_every_constant_strain_state() {
    let mat = steel();
    for kind in ALL_KINDS {
        let el = element_for(kind);
        let coords = distorted(kind);
        let n_gp = el.n_gp();
        let (mut sig, mut eps) = (vec![0.0; n_gp * VOIGT], vec![0.0; n_gp * VOIGT]);
        for id in idealisations(kind) {
            for form in [Formulation::Full, Formulation::IncompatibleModes] {
                for e in patch_modes(&id) {
                    let c = ctx(&coords, &mat, id.clone(), form);
                    let u = patch_displacement(kind, &id, &coords, &e);
                    el.recover(&c, &u, &mut sig, &mut eps).expect("ok");
                    let want = expected_stress(&id, &e);
                    for g in 0..n_gp {
                        close(&eps[g * VOIGT..(g + 1) * VOIGT], &e, 1e-13);
                        close(&sig[g * VOIGT..(g + 1) * VOIGT], &want, 1e-10);
                    }
                }
            }
        }
    }
}

/// A1 across SI length scales: constant strain gives the same stress, while its energy
/// and the heat integral follow the independently known physical volume (or weighted area).
#[test]
fn element_patch_and_integrals_are_valid_from_nanometres_to_megametres() {
    let mat = steel();
    for kind in ALL_KINDS {
        let el = element_for(kind);
        let (original, base, rbar) = simple(kind);
        let (nn, nd, dim) = (kind.n_nodes(), el.n_dof(), kind.dim());
        let simplex = kind.n_corners() == dim + 1;
        let reference = if simplex {
            if dim == 3 {
                1.0 / 6.0
            } else {
                0.5
            }
        } else {
            2.0f64.powi(dim as i32)
        };
        for length in [1e-9f64, 1e-6, 1e-5, 1e-3, 1.0, 1e3, 1e6] {
            let coords: Vec<f64> = original.iter().map(|x| length * x).collect();
            let want_det = base / reference * length.powi(dim as i32);
            let det = min_det_j(kind, &coords).expect("a positively oriented similar element");
            assert!((det / want_det - 1.0).abs() < 1e-12, "{kind:?} L={length}: det {det} vs {want_det}");
            // An off-centre point mapped analytically, independent of the Newton inversion.
            let xi = [0.2, 0.1, if dim == 3 { 0.15 } else { 0.0 }];
            let point = if simplex { simplex_map(xi) } else { box_map(xi) }.map(|x| length * x);
            close(&el.inverse_map(&coords, point).expect("an interior point"), &xi, 1e-12);
            for id in idealisations(kind) {
                let volume = weighted(&id, base * length.powi(dim as i32), rbar * length);
                let c = ctx(&coords, &mat, id.clone(), Formulation::Full);
                let mut heat_k = vec![0.0; nn * nn];
                femlab_engine::fem::heat::conductivity(kind, &c, &mut heat_k).expect("valid heat element");
                let temperature: Vec<f64> = coords.iter().step_by(3).copied().collect();
                let kt = mat_vec(&heat_k, nn, &temperature);
                let energy: f64 = temperature.iter().zip(kt).map(|(t, q)| t * q).sum();
                assert!((energy / (mat.k * volume) - 1.0).abs() < 1e-11, "{kind:?} {id:?} L={length}: heat");
                for form in [Formulation::Full, Formulation::IncompatibleModes] {
                    let c = ctx(&coords, &mat, id.clone(), form);
                    let mut k = vec![0.0; nd * nd];
                    el.stiffness(&c, &mut k).expect("valid stiffness");
                    let (mut sig, mut eps) = (vec![0.0; el.n_gp() * VOIGT], vec![0.0; el.n_gp() * VOIGT]);
                    for strain in patch_modes(&id) {
                        let u = patch_displacement(kind, &id, &coords, &strain);
                        let stress = expected_stress(&id, &strain);
                        el.recover(&c, &u, &mut sig, &mut eps).expect("valid recovery");
                        for gp in 0..el.n_gp() {
                            close(&eps[gp * VOIGT..(gp + 1) * VOIGT], &strain, 1e-12);
                            close(&sig[gp * VOIGT..(gp + 1) * VOIGT], &stress, 1e-10);
                        }
                        let ku = mat_vec(&k, nd, &u);
                        let energy: f64 = u.iter().zip(ku).map(|(u, f)| u * f).sum();
                        let want = volume * strain.iter().zip(stress).map(|(e, s)| e * s).sum::<f64>();
                        assert!((energy / want - 1.0).abs() < 1e-10, "{kind:?} {id:?} {form:?} L={length}: energy");
                    }
                }
            }
        }
    }
}

#[test]
fn jacobian_rejects_inversion_and_relative_collapse_at_every_length_scale() {
    let mat = steel();
    for kind in ALL_KINDS {
        let el = element_for(kind);
        let (original, _, _) = simple(kind);
        for length in [1e-9f64, 1e-5, 1.0, 1e6] {
            for flatten in [-1.0, 0.0, 1e-16] {
                let mut coords: Vec<f64> = original.iter().map(|x| length * x).collect();
                for x in coords.iter_mut().skip(kind.dim() - 1).step_by(3) {
                    *x *= flatten;
                }
                assert!(min_det_j(kind, &coords).is_none(), "{kind:?} L={length}, flatten={flatten}");
                assert!(el.inverse_map(&coords, [0.0; 3]).is_none());
                let mut k = vec![0.0; el.n_dof() * el.n_dof()];
                let id = idealisations(kind).swap_remove(0);
                let c = ctx(&coords, &mat, id, Formulation::Full);
                assert_eq!(el.stiffness(&c, &mut k).unwrap_err().code, ErrorCode::MeshInverted);
            }
        }
        assert!(min_det_j(kind, &vec![0.0; kind.n_nodes() * 3]).is_none());
        // A well-shaped map still cannot return a physical determinant that f64 cannot
        // represent. These hit the lower and upper numeric limits, not a geometric cutoff.
        for length in [1e-200, 1e200] {
            let coords: Vec<f64> = original.iter().map(|x| length * x).collect();
            assert!(min_det_j(kind, &coords).is_none());
        }
        let mut nonfinite = original;
        nonfinite[0] = f64::NAN;
        assert!(min_det_j(kind, &nonfinite).is_none());
    }
}

#[test]
fn consistent_and_lumped_mass_both_total_rho_v() {
    let mat = steel();
    for kind in ALL_KINDS {
        let el = element_for(kind);
        let (coords, base, rbar) = simple(kind);
        let n = el.n_dof();
        let mut m = vec![0.0; n * n];
        for id in idealisations(kind) {
            let want = DENSITY * weighted(&id, base, rbar);
            let c = ctx(&coords, &mat, id.clone(), Formulation::Full);
            el.mass(&c, &mut m, false).expect("ok");
            let total = m.iter().sum::<f64>() / kind.dim() as f64;
            assert!((total - want).abs() <= 1e-11 * want, "{kind:?} {id:?} consistent {total} vs {want}");
            for i in 0..n {
                for j in 0..n {
                    assert!((m[i * n + j] - m[j * n + i]).abs() <= 1e-12 * want);
                }
            }
            el.mass(&c, &mut m, true).expect("ok");
            let total = m.iter().sum::<f64>() / kind.dim() as f64;
            assert!((total - want).abs() <= 1e-11 * want, "{kind:?} {id:?} lumped {total} vs {want}");
            for i in 0..n {
                assert!(m[i * n + i] > 0.0, "{kind:?} lumped diagonal {i} is not positive");
                for j in 0..n {
                    assert!(i == j || m[i * n + j] == 0.0);
                }
            }
        }
    }
}

#[test]
fn zero_density_element_mass_is_exactly_zero_and_negative_density_is_rejected() {
    let mut mat = steel();
    mat.rho = 0.0;
    for kind in ALL_KINDS {
        let el = element_for(kind);
        let (coords, _, _) = simple(kind);
        let n = el.n_dof();
        let mut m = vec![f64::NAN; n * n];
        for id in idealisations(kind) {
            let c = ctx(&coords, &mat, id, Formulation::Full);
            for lumped in [false, true] {
                el.mass(&c, &mut m, lumped).expect("zero density is a valid zero element mass");
                assert!(m.iter().all(|&v| v == 0.0), "{kind:?}, lumped = {lumped}: {m:?}");
            }
            let e = el.omega_max(&c).expect_err("a massless element has no frequency bound");
            assert_eq!(e.code, ErrorCode::ModelIllPosed);
            assert_eq!(e.where_.as_deref(), Some("material.rho"));
        }
    }

    let kind = ElementKind::Hex8;
    let el = element_for(kind);
    let (coords, _, _) = simple(kind);
    let mut m = vec![0.0; el.n_dof() * el.n_dof()];
    for rho in [-1.0, f64::NAN] {
        mat.rho = rho;
        let c = ctx(&coords, &mat, Idealisation::Solid3d, Formulation::Full);
        let e = el.mass(&c, &mut m, true).expect_err("negative or non-finite mass is invalid");
        assert_eq!(e.code, ErrorCode::ModelIllPosed);
        assert_eq!(e.where_.as_deref(), Some("material.rho"));
        assert!(e.suggestion.as_deref().is_some_and(|s| s.contains("rho")));
    }
}

#[test]
fn a_constant_body_force_totals_f_times_volume() {
    let mat = steel();
    let g = [0.0, -9.81 * DENSITY, 0.0];
    for kind in ALL_KINDS {
        let el = element_for(kind);
        let (coords, base, rbar) = simple(kind);
        let mut f = vec![0.0; el.n_dof()];
        for id in idealisations(kind) {
            let vw = weighted(&id, base, rbar);
            let c = ctx(&coords, &mat, id.clone(), Formulation::Full);
            el.body_load(&c, &|_x| g, &mut f).expect("ok");
            for (i, &gi) in g.iter().enumerate().take(kind.dim()) {
                let total: f64 = f.iter().skip(i).step_by(kind.dim()).sum();
                let want = gi * vw;
                assert!((total - want).abs() <= 1e-10 * (1.0 + want.abs()), "{kind:?} {id:?} dir {i}: {total}");
            }
        }
    }
}

#[test]
fn face_pressure_and_traction_integrate_to_the_face_area() {
    let mat = steel();
    let t = [1e5, -2e5, 3e4];
    for kind in ALL_KINDS {
        let el = element_for(kind);
        let (coords, _, _) = simple(kind);
        let dim = kind.dim();
        let mut out = vec![0.0; el.n_dof()];
        for id in idealisations(kind) {
            let c = ctx(&coords, &mat, id.clone(), Formulation::Full);
            for f in 0..kind.n_faces() {
                let (area, normal, rbar) = face_geometry(kind, &coords, f);
                let aw = weighted(&id, area, rbar);
                el.face_load(&c, f as u8, FaceLoad::Pressure(PRESSURE), &mut out).expect("ok");
                for (i, &ni) in normal.iter().enumerate().take(dim) {
                    let total: f64 = out.iter().skip(i).step_by(dim).sum();
                    let want = -PRESSURE * aw * ni;
                    assert!(
                        (total - want).abs() <= 1e-9 * (1.0 + want.abs()),
                        "{kind:?} {id:?} face {f} pressure dir {i}: {total} vs {want}"
                    );
                }
                el.face_load(&c, f as u8, FaceLoad::Traction(t), &mut out).expect("ok");
                for (i, &ti) in t.iter().enumerate().take(dim) {
                    let total: f64 = out.iter().skip(i).step_by(dim).sum();
                    let want = ti * aw;
                    assert!(
                        (total - want).abs() <= 1e-9 * (1.0 + want.abs()),
                        "{kind:?} {id:?} face {f} traction dir {i}: {total} vs {want}"
                    );
                }
            }
        }
    }
}

#[test]
fn thermal_load_is_the_stiffness_times_the_free_expansion() {
    let mat = steel();
    let dt = 50.0;
    for kind in ALL_KINDS {
        let el = element_for(kind);
        let coords = distorted(kind);
        let n = el.n_dof();
        let n_gp = el.n_gp();
        let temps = vec![20.0 + dt; kind.n_nodes()];
        let (mut sig, mut eps) = (vec![0.0; n_gp * VOIGT], vec![0.0; n_gp * VOIGT]);
        for id in idealisations(kind) {
            // free expansion: α ΔT, except in plane strain where the blocked ε₃₃ inflates it
            let free = match id {
                Idealisation::PlaneStrain => (1.0 + POISSON) * EXPANSION * dt,
                _ => EXPANSION * dt,
            };
            for form in [Formulation::Full, Formulation::IncompatibleModes] {
                let mut c = ctx(&coords, &mat, id.clone(), form);
                c.temperature = Some(&temps);
                c.t_ref = 20.0;
                let u = nodal_field(kind, &coords, &|x: [f64; 3]| [free * x[0], free * x[1], free * x[2]]);
                let mut f = vec![0.0; n];
                el.thermal_load(&c, &mut f).expect("ok");
                let mut k = vec![0.0; n * n];
                el.stiffness(&c, &mut k).expect("ok");
                let ku = mat_vec(&k, n, &u);
                let scale = inf_norm(&f);
                assert!(scale > 0.0);
                for i in 0..n {
                    assert!((ku[i] - f[i]).abs() <= 1e-9 * scale, "{kind:?} {id:?} {form:?} [{i}]");
                }
                // the free expansion leaves no in-plane stress
                el.recover(&c, &u, &mut sig, &mut eps).expect("ok");
                let bound = 1e-6 * YOUNG * EXPANSION * dt;
                for g in 0..n_gp {
                    for i in [0usize, 1, 3] {
                        assert!(sig[g * VOIGT + i].abs() <= bound, "{kind:?} {id:?} gp {g} σ{i}");
                    }
                }
                // no temperature, no thermal load
                let cold = ctx(&coords, &mat, id.clone(), form);
                el.thermal_load(&cold, &mut f).expect("ok");
                assert!(f.iter().all(|v| *v == 0.0), "{kind:?} {id:?}");
            }
        }
    }
}

struct LegacyInverseMap {
    inner: &'static dyn Element,
    mapped: Option<[f64; 3]>,
}

impl Element for LegacyInverseMap {
    fn kind(&self) -> ElementKind {
        self.inner.kind()
    }
    fn n_dof(&self) -> usize {
        self.inner.n_dof()
    }
    fn n_gp(&self) -> usize {
        self.inner.n_gp()
    }
    fn stiffness(&self, c: &ElementCtx<'_>, k: &mut [f64]) -> Result<f64, Error> {
        self.inner.stiffness(c, k)
    }
    fn mass(&self, c: &ElementCtx<'_>, m: &mut [f64], lumped: bool) -> Result<(), Error> {
        self.inner.mass(c, m, lumped)
    }
    fn body_load(&self, c: &ElementCtx<'_>, f: &dyn Fn([f64; 3]) -> [f64; 3], out: &mut [f64]) -> Result<(), Error> {
        self.inner.body_load(c, f, out)
    }
    fn thermal_load(&self, c: &ElementCtx<'_>, out: &mut [f64]) -> Result<(), Error> {
        self.inner.thermal_load(c, out)
    }
    fn face_load(&self, c: &ElementCtx<'_>, local_face: u8, load: FaceLoad, out: &mut [f64]) -> Result<(), Error> {
        self.inner.face_load(c, local_face, load, out)
    }
    fn recover(&self, c: &ElementCtx<'_>, u: &[f64], stress: &mut [f64], strain: &mut [f64]) -> Result<(), Error> {
        self.inner.recover(c, u, stress, strain)
    }
    fn tangent_and_force(
        &self,
        c: &ElementCtx<'_>,
        u: &[f64],
        state_in: &[f64],
        out: TangentOut<'_>,
    ) -> Result<f64, Error> {
        self.inner.tangent_and_force(c, u, state_in, out)
    }
    fn gp_xi(&self, i: usize) -> [f64; 3] {
        self.inner.gp_xi(i)
    }
    fn shape_at(&self, xi: [f64; 3], n: &mut [f64]) {
        self.inner.shape_at(xi, n);
    }
    fn inverse_map(&self, _coords: &[f64], _x: [f64; 3]) -> Option<[f64; 3]> {
        self.mapped
    }
    fn omega_max(&self, c: &ElementCtx<'_>) -> Result<f64, Error> {
        self.inner.omega_max(c)
    }
}

#[test]
fn inverse_map_round_trips_the_gauss_points_and_rejects_the_rest() {
    let legacy = LegacyInverseMap { inner: element_for(ElementKind::Hex8), mapped: Some([0.25, -0.5, 0.75]) };
    assert_eq!(legacy.inverse_map_status(&[], [0.0; 3]), InverseMap::Inside([0.25, -0.5, 0.75]));
    let legacy = LegacyInverseMap { inner: element_for(ElementKind::Hex8), mapped: None };
    assert_eq!(legacy.inverse_map_status(&[], [0.0; 3]), InverseMap::Failed);
    // every other method is the inner element's, the finite-strain one included
    let (coords, mat) = (distorted(ElementKind::Hex8), steel());
    let c = ctx(&coords, &mat, Idealisation::Solid3d, Formulation::Full);
    let u: Vec<f64> = (0..legacy.n_dof()).map(|i| 1e-3 * (i as f64 + 1.0)).collect();
    let (nd, n_gp) = (legacy.n_dof(), legacy.n_gp());
    let (mut k, mut f) = (vec![0.0; nd * nd], vec![0.0; nd]);
    let (mut stress, mut strain) = (vec![0.0; n_gp * VOIGT], vec![0.0; n_gp * VOIGT]);
    let mut state = Vec::new();
    let out = TangentOut { k: &mut k, f: &mut f, stress: &mut stress, strain: &mut strain, state: &mut state };
    legacy.tangent_and_force(&c, &u, &[], out).expect("the wrapper forwards");
    let (k_inner, f_inner, s_inner, e_inner) =
        element_tangent(ElementKind::Hex8, &c, &u).expect("the inner element answers");
    assert_eq!((k, f, stress, strain), (k_inner, f_inner, s_inner, e_inner));

    for kind in ALL_KINDS {
        let el = element_for(kind);
        let coords = distorted(kind);
        let mut n = vec![0.0; kind.n_nodes()];
        for i in 0..el.n_gp() {
            let xi = el.gp_xi(i);
            assert_eq!(xi, rule_of(kind).points[i]);
            el.shape_at(xi, &mut n);
            let mut x = [0.0; 3];
            for (a, &v) in n.iter().enumerate() {
                for (k, xk) in x.iter_mut().enumerate() {
                    *xk += v * coords[3 * a + k];
                }
            }
            let back = el.inverse_map(&coords, x).expect("a Gauss point is inside");
            for k in 0..kind.dim() {
                assert!((back[k] - xi[k]).abs() <= 1e-10, "{kind:?} gp {i} dir {k}");
            }
        }
        let outside_xi = match kind {
            ElementKind::Hex8 | ElementKind::Hex20 | ElementKind::Quad4 | ElementKind::Quad8 | ElementKind::Truss2 => {
                [1.1, 0.0, 0.0]
            }
            ElementKind::Tet4 | ElementKind::Tet10 | ElementKind::Tri3 | ElementKind::Tri6 => [-0.1, 0.0, 0.0],
        };
        el.shape_at(outside_xi, &mut n);
        let outside =
            std::array::from_fn(|k| n.iter().enumerate().map(|(node, value)| value * coords[3 * node + k]).sum());
        assert_eq!(el.inverse_map_status(&coords, outside), InverseMap::Outside, "{kind:?} mapped outside point");
        assert_eq!(el.inverse_map_status(&folded(kind), [2.0, 1.0, 0.5]), InverseMap::Failed, "{kind:?} folded");
        assert_eq!(el.inverse_map_status(&coords, [f64::NAN, 0.0, 0.0]), InverseMap::Failed, "{kind:?} nonfinite");
    }
    assert_eq!(
        element_for(ElementKind::Hex20).inverse_map_status(&distorted(ElementKind::Hex20), [100.0; 3]),
        InverseMap::Failed,
        "a valid curved element must report a far Newton failure rather than guessing from the last iterate"
    );
    assert_eq!(
        element_for(ElementKind::Hex20).inverse_map_status(&distorted(ElementKind::Hex20), [f64::MAX; 3]),
        InverseMap::Failed,
        "a finite request whose Newton update overflows is still a locator failure"
    );
    let extreme_quad = vec![
        -f64::MAX,
        -1.0,
        0.0,
        f64::MAX,
        -1.0,
        0.0,
        -f64::MAX,
        1.0,
        0.0,
        f64::MAX,
        1.0,
        0.0,
        0.0,
        -1.0,
        0.0,
        1.0,
        0.0,
        0.0,
        0.0,
        1.0,
        0.0,
        -1.0,
        0.0,
        0.0,
    ];
    assert_eq!(
        element_for(ElementKind::Quad8).inverse_map_status(&extreme_quad, [f64::MAX / 4.0, 0.0, 0.0]),
        InverseMap::Failed,
        "finite opposite-sign extrema must not overflow the residual tolerance and accept the centre"
    );
}

#[test]
fn a_curved_quadratic_probe_is_not_rejected_by_its_nodal_box() {
    let kind = ElementKind::Quad8;
    // This positively oriented isoparametric element has a curved top edge. At ξ = 5/6,
    // its physical x is 1.0296, beyond the largest nodal x (1.0); a nodal AABB is therefore
    // not a sound rejection bound for a quadratic element.
    let coords = vec![
        -1.0,
        -1.0,
        0.0,
        1.0,
        -1.0,
        0.0,
        1.0,
        1.0,
        0.0,
        -1.0,
        1.0,
        0.0,
        -0.623_871_456_418_218_1,
        -0.403_780_038_227_63,
        0.0,
        0.533_587_919_073_732_5,
        0.105_866_302_482_681_58,
        0.0,
        0.642_435_506_149_044_8,
        1.561_562_153_585_714_7,
        0.0,
        -1.519_061_237_959_067_1,
        0.008_414_688_222_026_179,
        0.0,
    ];
    assert!(min_det_j(kind, &coords).is_some(), "the curved map is positively oriented at its integration points");
    let element = element_for(kind);
    let physical = |xi: [f64; 3]| {
        let mut shape = vec![0.0; kind.n_nodes()];
        element.shape_at(xi, &mut shape);
        std::array::from_fn(|k| shape.iter().enumerate().map(|(node, value)| value * coords[3 * node + k]).sum())
    };
    let inside = physical([5.0 / 6.0, 1.0, 0.0]);
    assert!(inside[0] > coords.iter().step_by(3).copied().fold(f64::NEG_INFINITY, f64::max));
    let InverseMap::Inside(back) = element.inverse_map_status(&coords, inside) else {
        panic!("the curved edge point is inside")
    };
    assert!((back[0] - 5.0 / 6.0).abs() < 1e-10 && (back[1] - 1.0).abs() < 1e-10);
    assert_eq!(element.inverse_map_status(&coords, physical([1.2, 0.0, 0.0])), InverseMap::Outside);

    let mesh = Mesh {
        dim: 2,
        coords: coords.clone(),
        blocks: vec![ElementBlock { kind, conn: (0..8).collect(), first_elem: 0 }],
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::new(),
        face_sets: BTreeMap::new(),
    };
    let field = FieldData::new(Per::Node, 1, coords.iter().step_by(3).copied().collect());
    let (_, value) = probe(&mesh, &field, inside).expect("quadratic probing must not use the unsafe nodal box");
    assert!((value[0] - inside[0]).abs() < 1e-10, "linear-coordinate interpolation is exact");
    assert_eq!(
        probe_checked(&mesh, &field, [100.0; 3]),
        Ok(None),
        "the curved control hull proves a far point outside"
    );
    assert_eq!(
        probe_checked(&mesh, &field, [f64::NAN, 0.0, 0.0]),
        Err(0),
        "a nonfinite requested point reaches the locator and remains a numerical failure"
    );
    let mut nonfinite_mesh = mesh.clone();
    nonfinite_mesh.coords[0] = f64::NAN;
    assert_eq!(
        probe_checked(&nonfinite_mesh, &field, inside),
        Err(0),
        "nonfinite retained coordinates cannot be classified as outside coverage"
    );

    for kind in [ElementKind::Quad8, ElementKind::Hex20, ElementKind::Tri6, ElementKind::Tet10] {
        let mesh = Structured { kind, n: [1, 1, 1] }.box_([1.0; 3]);
        let field = FieldData::new(Per::Node, 1, vec![0.0; mesh.n_nodes()]);
        assert_eq!(
            probe_checked(&mesh, &field, [100.0; 3]),
            Ok(None),
            "a far point is positively outside a straight quadratic {kind:?}"
        );
    }
}

#[test]
fn omega_max_is_within_twenty_percent_of_the_exact_largest_eigenvalue() {
    let mat = steel();
    for kind in ALL_KINDS {
        let el = element_for(kind);
        let coords = distorted(kind);
        let id = idealisations(kind).swap_remove(0);
        let c = ctx(&coords, &mat, id, Formulation::Full);
        let n = el.n_dof();
        let mut k = vec![0.0; n * n];
        el.stiffness(&c, &mut k).expect("ok");
        let mut m = vec![0.0; n * n];
        el.mass(&c, &mut m, true).expect("ok");
        // M^-½ K M^-½ is symmetric and has the spectrum of M⁻¹ K
        let s: Vec<f64> = (0..n).map(|i| 1.0 / m[i * n + i].sqrt()).collect();
        let a: Vec<f64> = (0..n * n).map(|p| k[p] * s[p / n] * s[p % n]).collect();
        let want = jacobi_eigenvalues(&a, n).iter().fold(0.0f64, |x, &v| x.max(v)).sqrt();
        let got = el.omega_max(&c).expect("ok");
        assert!((got - want).abs() <= 0.2 * want, "{kind:?}: {got} vs {want}");
    }
}

#[test]
fn a_folded_element_is_a_mesh_inverted_error() {
    let mat = steel();
    for kind in ALL_KINDS {
        let el = element_for(kind);
        let coords = folded(kind);
        let n = el.n_dof();
        let n_gp = el.n_gp();
        let id = idealisations(kind).swap_remove(0);
        let c = ctx(&coords, &mat, id, Formulation::IncompatibleModes);
        let mut k = vec![0.0; n * n];
        let mut v = vec![0.0; n];
        let u = vec![0.0; n];
        let (mut sig, mut eps) = (vec![0.0; n_gp * VOIGT], vec![0.0; n_gp * VOIGT]);
        let fails = [
            el.stiffness(&c, &mut k).err(),
            el.mass(&c, &mut k, true).err(),
            el.body_load(&c, &|_x| [0.0; 3], &mut v).err(),
            el.thermal_load(&c, &mut v).err(),
            el.recover(&c, &u, &mut sig, &mut eps).err(),
            // the finite-strain kernel refuses a folded *reference* element as flatly as the
            // linear ones do, before any deformation gradient is formed
            element_tangent(kind, &c, &u).err(),
            el.omega_max(&c).err(),
        ];
        for e in fails {
            let e = e.expect("a folded element must fail");
            assert_eq!(e.code, ErrorCode::MeshInverted, "{kind:?}");
            assert_eq!(e.where_.as_deref(), Some("element"));
        }
    }
}

#[test]
fn incompatible_modes_change_only_hex8_and_quad4() {
    let mat = steel();
    for kind in ALL_KINDS {
        let el = element_for(kind);
        let coords = distorted(kind);
        let n = el.n_dof();
        let id = idealisations(kind).swap_remove(0);
        let (mut full, mut im) = (vec![0.0; n * n], vec![0.0; n * n]);
        el.stiffness(&ctx(&coords, &mat, id.clone(), Formulation::Full), &mut full).expect("ok");
        el.stiffness(&ctx(&coords, &mat, id, Formulation::IncompatibleModes), &mut im).expect("ok");
        let has_modes = kind == ElementKind::Hex8 || kind == ElementKind::Quad4;
        assert_eq!(full == im, !has_modes, "{kind:?}");
    }
}

#[test]
fn incompatible_modes_bend_a_one_element_cantilever_exactly() {
    // A rectangle in plane stress with ν = 0: pure bending has no Poisson coupling, so
    // Euler–Bernoulli is the exact elasticity answer, and the incompatible modes reach it
    // because the bubble supplies the x² term the bilinear field is missing.
    let (l, h, t, young, moment) = (4.0, 1.0, 0.5, 1.0e7, 100.0);
    let mat = Material {
        law: builtin_law("linear-elastic").expect("built in"),
        props: vec![young, 0.0],
        rho: 1.0,
        alpha: 0.0,
        k: 0.0,
        cp: 0.0,
    };
    let coords = vec![0.0, 0.0, 0.0, l, 0.0, 0.0, l, h, 0.0, 0.0, h, 0.0];
    let el = element_for(ElementKind::Quad4);
    // the consistent nodal couple of a linear end stress: ±M/h at the two right-hand nodes
    let mut f = [0.0; 8];
    f[2] = moment / h;
    f[4] = -moment / h;
    let free = [2usize, 3, 4, 5];
    let mut tip = [0.0; 2];
    for (slot, form) in [Formulation::Full, Formulation::IncompatibleModes].into_iter().enumerate() {
        let c = ctx(&coords, &mat, Idealisation::PlaneStress { thickness: t }, form);
        let mut k = vec![0.0; 64];
        el.stiffness(&c, &mut k).expect("ok");
        let mut kr = vec![0.0; 16];
        for (a, &i) in free.iter().enumerate() {
            for (b, &j) in free.iter().enumerate() {
                kr[a * 4 + b] = k[i * 8 + j];
            }
        }
        let fr: Vec<f64> = free.iter().map(|&i| f[i]).collect();
        let ur = spd_solve(&kr, 4, &fr);
        tip[slot] = 0.5 * (ur[1] + ur[3]).abs();
    }
    let inertia = t * h * h * h / 12.0;
    let exact = moment * l * l / (2.0 * young * inertia);
    assert!(tip[1] > tip[0], "incompatible modes must be softer in bending: {tip:?}");
    assert!((tip[1] - exact).abs() <= 1e-10 * exact, "{tip:?} vs Euler–Bernoulli {exact}");
}

#[test]
fn elements_are_send_and_sync() {
    assert_send_sync::<&'static dyn Element>();
    assert_send_sync::<Iso<Hex8>>();
    assert_send_sync::<Material>();
    assert_eq!(FaceLoad::Pressure(1.0), FaceLoad::Pressure(1.0));
    assert_ne!(FaceLoad::Pressure(1.0), FaceLoad::Traction([1.0, 0.0, 0.0]));
}

#[test]
fn a_material_with_the_wrong_props_fails_every_integral_that_calls_the_law() {
    let bad = Material {
        law: builtin_law("linear-elastic").expect("built in"),
        props: vec![YOUNG],
        rho: DENSITY,
        alpha: EXPANSION,
        k: 0.0,
        cp: 0.0,
    };
    let cases = [
        (ElementKind::Hex8, Idealisation::Solid3d),
        (ElementKind::Quad4, Idealisation::PlaneStress { thickness: THICKNESS }),
    ];
    for (kind, id) in cases {
        let el = element_for(kind);
        let coords = distorted(kind);
        let n = el.n_dof();
        let n_gp = el.n_gp();
        let temps = vec![30.0; kind.n_nodes()];
        let mut c = ctx(&coords, &bad, id, Formulation::IncompatibleModes);
        c.temperature = Some(&temps);
        let mut k = vec![0.0; n * n];
        let mut v = vec![0.0; n];
        let u = vec![0.0; n];
        let (mut sig, mut eps) = (vec![0.0; n_gp * VOIGT], vec![0.0; n_gp * VOIGT]);
        let fails = [
            el.stiffness(&c, &mut k).err(),
            el.thermal_load(&c, &mut v).err(),
            el.recover(&c, &u, &mut sig, &mut eps).err(),
            el.omega_max(&c).err(),
        ];
        for e in fails {
            let e = e.expect("a props mismatch must fail");
            assert_eq!(e.code, ErrorCode::MaterialProps, "{kind:?}");
            assert_eq!(e.where_.as_deref(), Some("material.props"));
        }
        // the geometry itself is fine: mass and the loads never call the law
        assert!(el.mass(&c, &mut k, true).is_ok());
        assert!(el.body_load(&c, &|_x| [0.0; 3], &mut v).is_ok());
    }
}

// ==================================================================================
// Mesh I/O: Gmsh `.msh`, Abaqus `.inp`, STL (plan C §3; master commit 30).
// ==================================================================================

use femlab_engine::io::msh::gmsh_permutation;
use femlab_engine::io::vtu::base64;
use femlab_engine::io::{
    base64_decode, read_msh, read_stl, write_inp, write_msh, write_stl, write_stl_mesh, write_vtu,
};
use femlab_geometry::{elliptic_annulus, split_to_simplices, ElementBlock, Face, Shape, Sketch, Solid, TriMesh};

// ---------------------------------------------------------------- msh: gmsh_permutation

#[test]
fn gmsh_permutation_is_identity_except_tet10_and_hex20() {
    for kind in [
        ElementKind::Hex8,
        ElementKind::Tet4,
        ElementKind::Quad4,
        ElementKind::Quad8,
        ElementKind::Tri3,
        ElementKind::Tri6,
    ] {
        let perm = gmsh_permutation(kind);
        let identity: Vec<u8> = (0..kind.n_nodes() as u8).collect();
        assert_eq!(perm, identity.as_slice(), "{kind:?}");
    }
    let tet10 = gmsh_permutation(ElementKind::Tet10);
    assert_eq!(&tet10[..8], &(0..8u8).collect::<Vec<_>>()[..]);
    assert_eq!((tet10[8], tet10[9]), (9, 8));
}

fn edge_midpoint(coords: &[f64], a: u32, b: u32) -> [f64; 3] {
    let pa = &coords[3 * a as usize..3 * a as usize + 3];
    let pb = &coords[3 * b as usize..3 * b as usize + 3];
    [(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0, (pa[2] + pb[2]) / 2.0]
}

#[test]
fn gmsh_hex20_permutation_matches_gmshs_published_edge_order() {
    // Gmsh's own mid-edge order (plan C §1) — an independent oracle, not read from our source.
    const GMSH_HEX20_EDGES: [[u8; 2]; 12] =
        [[0, 1], [0, 3], [0, 4], [1, 2], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 7], [5, 6], [6, 7]];
    let perm = gmsh_permutation(ElementKind::Hex20);
    let abaqus_edges = ElementKind::Hex20.edges();
    for (g, pair) in GMSH_HEX20_EDGES.iter().enumerate() {
        let abaqus_local = perm[8 + g] as usize - 8;
        let e = abaqus_edges[abaqus_local];
        let matches = (e[0] == pair[0] && e[1] == pair[1]) || (e[0] == pair[1] && e[1] == pair[0]);
        assert!(matches, "gmsh edge {g} {pair:?} maps to abaqus edge {e:?}");
    }

    // Pin the direction with real coordinates: the node the writer puts at gmsh position 8+g is
    // the midpoint of that Gmsh edge's two corners.
    let m = Structured { kind: ElementKind::Hex20, n: [1, 1, 1] }.box_([1.3, 0.9, 1.7]);
    let text = write_msh(&m);
    let elements = text.split("$Elements\n").nth(1).unwrap().split("$EndElements").next().unwrap();
    let lines: Vec<&str> = elements.lines().collect();
    let hdr_idx = lines.iter().position(|&l| l == "3 1 17 1").expect("the hex20 block header");
    let ids: Vec<u32> = lines[hdr_idx + 1].split_whitespace().skip(1).map(|s| s.parse::<u32>().unwrap() - 1).collect();
    assert_eq!(ids.len(), 20);
    let conn = &m.blocks[0].conn;
    for (g, pair) in GMSH_HEX20_EDGES.iter().enumerate() {
        let want = edge_midpoint(&m.coords, conn[pair[0] as usize], conn[pair[1] as usize]);
        let got = &m.coords[3 * ids[8 + g] as usize..3 * ids[8 + g] as usize + 3];
        for k in 0..3 {
            assert!((got[k] - want[k]).abs() < 1e-9, "gmsh edge {g}: {got:?} vs {want:?}");
        }
    }
}

fn assert_mid_nodes_are_edge_midpoints(m: &Mesh) {
    for blk in &m.blocks {
        let nc = blk.kind.n_corners();
        if blk.kind.n_nodes() == nc {
            continue;
        }
        for en in blk.conn.chunks_exact(blk.kind.n_nodes()) {
            for (i, &[a, b]) in blk.kind.edges().iter().enumerate() {
                let want = edge_midpoint(&m.coords, en[a as usize], en[b as usize]);
                let id = en[nc + i] as usize;
                let got = &m.coords[3 * id..3 * id + 3];
                for k in 0..3 {
                    assert!((got[k] - want[k]).abs() < 1e-6, "{:?} mid-edge {i}: {got:?} vs {want:?}", blk.kind);
                }
            }
        }
    }
}

// ---------------------------------------------------------------- msh: round trip

fn assert_msh_round_trips(m: &Mesh, label: &str) -> Mesh {
    let text = write_msh(m);
    let back = read_msh(&text).unwrap_or_else(|e| panic!("{label}: {e}"));
    assert_eq!(&back, m, "{label}");
    back
}

#[test]
fn msh_round_trips_box_meshes_of_every_kind() {
    for kind in [
        ElementKind::Hex8,
        ElementKind::Hex20,
        ElementKind::Tet4,
        ElementKind::Tet10,
        ElementKind::Quad4,
        ElementKind::Quad8,
        ElementKind::Tri3,
        ElementKind::Tri6,
    ] {
        let n = if kind.dim() == 3 { [2, 1, 1] } else { [2, 2, 1] };
        let m = Structured { kind, n }.box_([1.3, 0.9, 1.7]);
        assert_msh_round_trips(&m, &format!("{kind:?} box"));
    }
}

#[test]
fn msh_round_trip_hex20_and_tet10_mid_nodes_are_true_edge_midpoints() {
    for kind in [ElementKind::Hex20, ElementKind::Tet10] {
        let m = Structured { kind, n: [2, 1, 1] }.box_([1.3, 0.9, 1.7]);
        let back = assert_msh_round_trips(&m, &format!("{kind:?} mid-nodes"));
        assert_mid_nodes_are_edge_midpoints(&back);
    }
}

#[test]
fn msh_round_trips_split_to_simplices() {
    for kind in [ElementKind::Hex8, ElementKind::Hex20, ElementKind::Quad4, ElementKind::Quad8] {
        let n = if kind.dim() == 3 { [2, 1, 1] } else { [2, 2, 1] };
        let grid = Structured { kind, n }.box_([1.3, 0.9, 1.7]);
        let split = split_to_simplices(&grid);
        assert_msh_round_trips(&split, &format!("split {kind:?}"));
    }
}

#[test]
fn msh_round_trips_annulus_and_elliptic_annulus() {
    let a = annulus(ElementKind::Quad8, 2, 3, 1.0, 2.0, [0.0, std::f64::consts::FRAC_PI_2]);
    assert_msh_round_trips(&a, "annulus quad8");
    let e = elliptic_annulus(ElementKind::Hex20, [2, 2], [2.0, 1.0], [3.25, 2.75], Some((1.5, 1)));
    assert_msh_round_trips(&e, "elliptic annulus hex20");
    let e2 = elliptic_annulus(ElementKind::Tet10, [1, 1], [2.0, 1.0], [3.25, 2.75], None);
    assert_msh_round_trips(&e2, "elliptic annulus tet10 (split)");
}

#[test]
fn msh_round_trips_a_two_block_mesh_with_a_block_partial_elem_set() {
    // Two disjoint hex8 blocks. "all" spans both (whole-mesh entities pick it up); "half" spans
    // only block 0's elements; "mixed" covers only element 0 of block 0. The latter forces the
    // writer to split the original element block into physical entities without changing element
    // order. "pins" is an independent node-only physical group.
    let a = Structured { kind: ElementKind::Hex8, n: [2, 1, 1] }.box_([1.0, 1.0, 1.0]);
    let b = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
    let n_nodes_a = a.n_nodes() as u32;
    let mut coords = a.coords.clone();
    coords.extend(b.coords.iter());
    let conn_b: Vec<u32> = b.blocks[0].conn.iter().map(|&n| n + n_nodes_a).collect();
    let m = Mesh {
        dim: 3,
        coords,
        blocks: vec![
            ElementBlock { kind: ElementKind::Hex8, conn: a.blocks[0].conn.clone(), first_elem: 0 },
            ElementBlock { kind: ElementKind::Hex8, conn: conn_b, first_elem: 2 },
        ],
        node_sets: BTreeMap::from([("pins".to_string(), vec![0, n_nodes_a])]),
        elem_sets: BTreeMap::from([
            ("all".to_string(), (0..3u32).collect()),
            ("half".to_string(), (0..2u32).collect()),
            ("mixed".to_string(), vec![0]),
        ]),
        face_sets: BTreeMap::new(),
    };
    let text = write_msh(&m);
    let back = read_msh(&text).unwrap();
    assert_eq!(back.coords, m.coords);
    for elem in 0..m.n_elems() as u32 {
        assert_eq!(back.elem_nodes(elem), m.elem_nodes(elem), "element {elem}");
    }
    assert_eq!(back.elem_sets.get("all"), Some(&(0..3u32).collect::<Vec<_>>()));
    assert_eq!(back.elem_sets.get("half"), Some(&(0..2u32).collect::<Vec<_>>()));
    assert_eq!(back.elem_sets.get("mixed"), Some(&vec![0]));
    assert_eq!(back.node_sets.get("pins"), Some(&vec![0, n_nodes_a]));
}

// ---------------------------------------------------------------- msh: read errors

fn good_msh_text() -> (String, Mesh) {
    let m = Mesh {
        dim: 2,
        coords: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        blocks: vec![ElementBlock { kind: ElementKind::Tri3, conn: vec![0, 1, 2], first_elem: 0 }],
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::from([("all".to_string(), vec![0])]),
        face_sets: BTreeMap::from([("bottom".to_string(), vec![Face { elem: 0, local: 0 }])]),
    };
    (write_msh(&m), m)
}

fn set_line_after(text: &str, marker: &str, offset: usize, new_line: &str) -> String {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let idx = lines.iter().position(|l| l == marker).unwrap_or_else(|| panic!("marker '{marker}' not found"));
    lines[idx + offset] = new_line.to_string();
    lines.join("\n") + "\n"
}

fn remove_lines_after(text: &str, marker: &str, offset: usize, count: usize) -> String {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let idx = lines.iter().position(|l| l == marker).unwrap_or_else(|| panic!("marker '{marker}' not found"));
    lines.drain(idx + offset..idx + offset + count);
    lines.join("\n") + "\n"
}

fn assert_schema_err(text: &str, want: &str) {
    let e = read_msh(text).unwrap_err();
    assert_eq!(e.code, ErrorCode::Schema);
    assert!(e.to_string().contains(want), "got '{e}', want it to contain '{want}'");
}

#[test]
fn read_msh_reports_the_line_of_a_truncated_file() {
    assert_schema_err("$MeshFormat", "unexpected end of file");
    assert_schema_err("", "unexpected end of file");
}

#[test]
fn read_msh_reports_unexpected_end_of_file_at_every_truncation_point() {
    // Every place read_msh asks for "the next line" is its own early-return path; a truncation
    // sweep hits each one once, wherever in the file it falls, without naming every line by hand.
    let (good, _) = good_msh_text();
    let lines: Vec<&str> = good.lines().collect();
    for n in 0..lines.len() {
        let truncated = lines[..n].join("\n") + "\n";
        let e = read_msh(&truncated).unwrap_err();
        assert_eq!(e.code, ErrorCode::Schema, "truncated after {n} lines");
    }
}

#[test]
fn read_msh_rejects_binary_files() {
    let (good, _) = good_msh_text();
    assert_schema_err(&good.replace("4.1 0 8", "4.1 1 8"), "binary");
}

#[test]
fn read_msh_rejects_a_version_other_than_4_1() {
    let (good, _) = good_msh_text();
    assert_schema_err(&good.replace("4.1 0 8", "9.9 0 8"), "4.1");
}

#[test]
fn read_msh_rejects_a_malformed_mesh_format_header() {
    let (good, _) = good_msh_text();
    assert_schema_err(&good.replace("4.1 0 8", "4.1 0"), "malformed $MeshFormat header");
}

#[test]
fn read_msh_rejects_a_missing_section() {
    let (good, _) = good_msh_text();
    let bad = good.replacen("$PhysicalNames\n", "", 1);
    assert_schema_err(&bad, "expected '$PhysicalNames'");
}

#[test]
fn read_msh_rejects_a_non_numeric_physical_name_count() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$PhysicalNames", 1, "two"), "expected a number");
}

#[test]
fn read_msh_rejects_a_physical_name_with_no_quotes() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$PhysicalNames", 2, "1 1 bottom"), "no quotes");
}

#[test]
fn read_msh_rejects_a_physical_name_with_an_unterminated_quote() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$PhysicalNames", 2, "1 1 \"bottom"), "no quotes");
}

#[test]
fn read_msh_rejects_a_malformed_physical_name_header() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$PhysicalNames", 2, "1 \"bottom\""), "malformed physical name header");
}

#[test]
fn read_msh_rejects_a_malformed_entities_header() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$Entities", 1, "0 1 1"), "malformed $Entities header");
}

#[test]
fn read_msh_reports_malformed_point_entities_and_unknown_physical_tags() {
    let (_, mut m) = good_msh_text();
    m.node_sets.insert("pin".into(), vec![0]);
    let good = write_msh(&m);
    assert_schema_err(&set_line_after(&good, "$Entities", 2, "1 0 0 0"), "malformed entity line");
    assert_schema_err(&set_line_after(&good, "$Entities", 2, "1 0 0 0 x 1"), "expected a number");
    assert_schema_err(&set_line_after(&good, "$Entities", 2, "1 0 0 0 1 99"), "physical tag 99");
}

#[test]
fn read_msh_rejects_an_entity_line_with_too_few_tokens() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$Entities", 2, "1 0 0 0"), "malformed entity line");
}

#[test]
fn read_msh_rejects_an_entity_line_whose_physical_tag_count_overruns_the_line() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$Entities", 2, "1 0 0 0 0 0 0 5 1"), "malformed entity line");
}

#[test]
fn read_msh_rejects_a_malformed_nodes_header() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$Nodes", 1, "1 3 1"), "malformed $Nodes header");
}

#[test]
fn read_msh_rejects_a_malformed_node_entity_block_header() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$Nodes", 2, "2 1 0"), "malformed node entity-block header");
}

#[test]
fn read_msh_rejects_parametric_nodes() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$Nodes", 2, "2 1 1 3"), "parametric nodes");
}

#[test]
fn read_msh_rejects_malformed_node_coordinates() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$Nodes", 6, "0.0 0.0"), "malformed node coordinates");
}

#[test]
fn read_msh_rejects_a_malformed_elements_header() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$Elements", 1, "2 2 1"), "malformed $Elements header");
}

#[test]
fn read_msh_rejects_a_malformed_element_entity_block_header() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$Elements", 2, "2 1 2"), "malformed element entity-block header");
}

#[test]
fn read_msh_rejects_an_unknown_gmsh_element_type_in_the_block_header() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$Elements", 2, "2 1 999 1"), "unknown gmsh element type 999");
}

#[test]
fn read_msh_rejects_a_malformed_element_line() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$Elements", 3, "1 1 2"), "malformed element line");
}

#[test]
fn read_msh_rejects_an_element_referencing_an_unknown_node() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$Elements", 3, "1 1 2 99"), "unknown node 99");
}

#[test]
fn read_msh_rejects_a_file_with_no_elements() {
    let (good, _) = good_msh_text();
    let mut t = set_line_after(&good, "$Elements", 1, "0 0 1 0");
    t = remove_lines_after(&t, "$Elements", 2, 4);
    assert_schema_err(&t, "no elements");
}

#[test]
fn read_msh_rejects_an_element_at_an_unsupported_entity_dimension() {
    let (good, _) = good_msh_text();
    // the boundary block's entity dim becomes 0, which is neither the mesh dim (2) nor 2 - 1
    assert_schema_err(&set_line_after(&good, "$Elements", 4, "0 1 1 1"), "unsupported element dimension");
}

#[test]
fn read_msh_rejects_a_line_element_placed_in_the_volume_dimension() {
    let (good, _) = good_msh_text();
    // Same entity dim as the mesh (2), but a line2 type. Gmsh type 1 is our own truss, which
    // belongs in a 3D mesh, so the Mesh refuses it here rather than the type table.
    assert_schema_err(&set_line_after(&good, "$Elements", 4, "2 1 1 1"), "Truss2 in a 2D mesh");
    // A line3 has no element kind at all, so that one is still refused by the type table.
    let mut t = set_line_after(&good, "$Elements", 4, "2 1 8 1");
    t = set_line_after(&t, "$Elements", 5, "2 1 2 3");
    assert_schema_err(&t, "unknown element type 8");
}

#[test]
fn read_msh_rejects_a_volume_only_element_placed_in_the_face_dimension() {
    let (good, _) = good_msh_text();
    let mut t = set_line_after(&good, "$Elements", 4, "1 1 4 1");
    t = set_line_after(&t, "$Elements", 5, "2 1 2 3 1");
    assert_schema_err(&t, "unknown element type 4");
}

#[test]
fn read_msh_rejects_a_volume_entity_with_an_undeclared_physical_tag() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$Entities", 3, "1 0 0 0 1 1 0 1 99 0"), "physical tag 99");
}

#[test]
fn read_msh_rejects_a_face_entity_with_an_undeclared_physical_tag() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$Entities", 2, "1 0 0 0 1 1 0 1 99 0"), "physical tag 99");
}

#[test]
fn read_msh_rejects_a_face_element_matching_no_boundary_face() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$Elements", 5, "2 1 1"), "does not match any boundary face");
}

#[test]
fn read_msh_rejects_a_non_numeric_token_at_every_numeric_field() {
    // One `parse_tok::<T>(...)?` per numeric field read; each is its own early-return path, so
    // each needs its own bad token to be exercised (a shared malformed-count test would only
    // ever hit the first one reached).
    let (good, _) = good_msh_text();
    let cases: &[(&str, usize, &str)] = &[
        ("$PhysicalNames", 2, "x 1 \"bottom\""), // physical name dim
        ("$PhysicalNames", 2, "1 x \"bottom\""), // physical name tag
        ("$Entities", 1, "x 1 1 0"),             // entities header counts
        ("$Entities", 2, "x 0 0 0 1 1 0 1 1 0"), // entity line tag
        ("$Entities", 2, "1 0 0 0 1 1 0 x 1 0"), // entity line n_phys
        ("$Entities", 2, "1 0 0 0 1 1 0 1 x 0"), // entity line physical tag
        ("$Nodes", 1, "x 3 1 3"),                // $Nodes header n_blocks
        ("$Nodes", 2, "2 1 0 x"),                // node entity-block header n_nodes
        ("$Nodes", 3, "x"),                      // a node tag
        ("$Nodes", 6, "x 0 0"),                  // node x coordinate
        ("$Nodes", 6, "0 x 0"),                  // node y coordinate
        ("$Nodes", 6, "0 0 x"),                  // node z coordinate
        ("$Elements", 1, "x 2 1 2"),             // $Elements header n_elem_blocks
        ("$Elements", 2, "x 1 2 1"),             // element entity-block header entity_dim
        ("$Elements", 2, "2 x 2 1"),             // element entity-block header entity_tag
        ("$Elements", 2, "2 1 x 1"),             // element entity-block header gmsh type
        ("$Elements", 2, "2 1 2 x"),             // element entity-block header n_in_block
        ("$Elements", 3, "1 x 2 3"),             // element line node reference
    ];
    for &(marker, offset, new_line) in cases {
        let bad = set_line_after(&good, marker, offset, new_line);
        let e = read_msh(&bad).unwrap_err();
        assert_eq!(e.code, ErrorCode::Schema, "{marker}+{offset} = '{new_line}'");
        assert!(e.to_string().contains("expected a number"), "{marker}+{offset}: {e}");
    }
}

// ---------------------------------------------------------------- inp

fn section_lines<'a>(text: &'a str, header: &str) -> Vec<&'a str> {
    let mut it = text.lines();
    for line in &mut it {
        if line == header {
            break;
        }
    }
    it.take_while(|l| !l.starts_with('*')).collect()
}

#[test]
fn inp_writes_node_and_element_counts_that_parse_back() {
    let m = Structured { kind: ElementKind::Hex20, n: [2, 1, 1] }.box_([1.0, 1.0, 1.0]);
    let text = write_inp(&m, "demo");
    assert!(text.starts_with("*HEADING\ndemo\n"));
    assert_eq!(section_lines(&text, "*NODE").len(), m.n_nodes());
    // C3D20 = 21 fields per element (id + 20 nodes), so 16 + 5 wraps onto two lines
    let elem_lines = section_lines(&text, "*ELEMENT, TYPE=C3D20, ELSET=BLOCK1");
    assert_eq!(elem_lines.len(), m.n_elems() * 2);
    assert_eq!(elem_lines[0].split(", ").count(), 16);
    assert_eq!(elem_lines[1].split(", ").count(), 5);
}

#[test]
fn inp_writes_every_set_and_correct_box_face_labels() {
    let m = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
    let text = write_inp(&m, "box");
    for name in ["xmin", "xmax", "ymin", "ymax", "zmin", "zmax"] {
        assert!(text.contains(&format!("*NSET, NSET={name}\n")), "{name}");
        assert!(text.contains(&format!("*SURFACE, TYPE=ELEMENT, NAME={name}\n")), "{name}");
    }
    assert!(text.contains("*ELSET, ELSET=all\n"));
    // hex S6/S4, S3/S5, S1/S2 on the low/high side per axis (structured.rs FACE_LOCAL_3D)
    for (name, want) in [("xmin", "S6"), ("xmax", "S4"), ("ymin", "S3"), ("ymax", "S5"), ("zmin", "S1"), ("zmax", "S2")]
    {
        let header = format!("*SURFACE, TYPE=ELEMENT, NAME={name}");
        let lines = section_lines(&text, &header);
        assert_eq!(lines.len(), 1, "{name}");
        assert!(lines[0].ends_with(&format!(", {want}")), "{name}: {}", lines[0]);
    }
}

/// A line member travels through all three formats: Gmsh's line element (type 1, both
/// directions), Abaqus's `T3D2` and VTK's `VTK_LINE`, mixed into a mesh that also has solids.
#[test]
fn a_line_block_round_trips_through_msh_and_names_itself_in_inp_and_vtu() {
    let solid = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
    let base = solid.n_nodes() as u32;
    let mut coords = solid.coords.clone();
    coords.extend([2.0, 0.0, 0.0, 3.0, 1.0, 0.5]);
    let m = Mesh {
        dim: 3,
        coords,
        blocks: vec![
            ElementBlock { kind: ElementKind::Hex8, conn: solid.blocks[0].conn.clone(), first_elem: 0 },
            ElementBlock { kind: ElementKind::Truss2, conn: vec![base, base + 1], first_elem: 1 },
        ],
        node_sets: BTreeMap::from([("joints".to_string(), vec![base, base + 1])]),
        elem_sets: BTreeMap::from([("members".to_string(), vec![1])]),
        face_sets: BTreeMap::new(),
    };
    m.validate().expect("a 1D block belongs in a 3D mesh");
    assert_msh_round_trips(&m, "hex8 plus truss2");
    let inp = write_inp(&m, "frame");
    assert!(inp.contains("*ELEMENT, TYPE=T3D2, ELSET=BLOCK2"), "{inp}");
    // VTK cell type 3 is VTK_LINE; the types array is base64, so check the mesh writes at all
    // and that the truss did not become a face or vanish.
    let vtu = write_vtu(&m, &[], &[]);
    assert!(vtu.contains("NumberOfCells=\"2\""), "{vtu}");
}

#[test]
fn inp_maps_every_element_kind_to_its_abaqus_type() {
    for (kind, want) in [
        (ElementKind::Hex8, "C3D8"),
        (ElementKind::Hex20, "C3D20"),
        (ElementKind::Tet4, "C3D4"),
        (ElementKind::Tet10, "C3D10"),
        (ElementKind::Quad4, "CPS4"),
        (ElementKind::Quad8, "CPS8"),
        (ElementKind::Tri3, "CPS3"),
        (ElementKind::Tri6, "CPS6"),
    ] {
        let m = Structured { kind, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
        let text = write_inp(&m, "t");
        assert!(text.contains(&format!("*ELEMENT, TYPE={want}, ELSET=BLOCK1")), "{kind:?} -> {want}");
    }
}

// ---------------------------------------------------------------- stl

#[derive(Debug)]
struct Facet {
    normal: [f64; 3],
    verts: [[f64; 3]; 3],
}

fn parse_stl(text: &str) -> Vec<Facet> {
    let mut out = Vec::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if let Some(rest) = line.strip_prefix("facet normal ") {
            let n: Vec<f64> = rest.split_whitespace().map(|s| s.parse().unwrap()).collect();
            lines.next(); // outer loop
            let mut verts = [[0.0; 3]; 3];
            for v in &mut verts {
                let vl = lines.next().unwrap().trim();
                let coords: Vec<f64> =
                    vl.strip_prefix("vertex ").unwrap().split_whitespace().map(|s| s.parse().unwrap()).collect();
                *v = [coords[0], coords[1], coords[2]];
            }
            lines.next(); // endloop
            lines.next(); // endfacet
            out.push(Facet { normal: [n[0], n[1], n[2]], verts });
        }
    }
    out
}

fn assert_unit_outward_normals(facets: &[Facet], centroid: [f64; 3]) {
    for f in facets {
        let len = (f.normal[0] * f.normal[0] + f.normal[1] * f.normal[1] + f.normal[2] * f.normal[2]).sqrt();
        assert!((len - 1.0).abs() < 1e-9, "{f:?}");
        let tc = [
            (f.verts[0][0] + f.verts[1][0] + f.verts[2][0]) / 3.0,
            (f.verts[0][1] + f.verts[1][1] + f.verts[2][1]) / 3.0,
            (f.verts[0][2] + f.verts[1][2] + f.verts[2][2]) / 3.0,
        ];
        let d = [tc[0] - centroid[0], tc[1] - centroid[1], tc[2] - centroid[2]];
        let dot = f.normal[0] * d[0] + f.normal[1] * d[1] + f.normal[2] * d[2];
        assert!(dot > 0.0, "{f:?}");
    }
}

fn assert_watertight(triangles: &[[u32; 3]]) {
    let mut edges = Vec::new();
    for t in triangles {
        edges.push((t[0], t[1]));
        edges.push((t[1], t[2]));
        edges.push((t[2], t[0]));
    }
    for &(u, v) in &edges {
        let forward = edges.iter().filter(|&&e| e == (u, v)).count();
        let backward = edges.iter().filter(|&&e| e == (v, u)).count();
        assert_eq!(forward, 1, "edge ({u},{v}) appears {forward} times in its own direction");
        assert_eq!(backward, 1, "edge ({u},{v}) has {backward} matching reverse edges");
    }
}

#[test]
fn stl_writes_a_unit_outward_normal_watertight_box_solid() {
    let solid = Solid::evaluate(&Shape::Box { size: [1.0, 1.0, 1.0] }).unwrap();
    let text = write_stl(solid.triangles(), "box");
    assert!(text.starts_with("solid box\n"));
    assert!(text.trim_end().ends_with("endsolid box"));
    let facets = parse_stl(&text);
    assert_eq!(facets.len(), solid.triangles().triangles.len());
    assert_unit_outward_normals(&facets, [0.5, 0.5, 0.5]);
    assert_watertight(&solid.triangles().triangles);
}

#[test]
fn stl_mesh_writes_a_unit_outward_normal_watertight_box_skin() {
    let m = Structured { kind: ElementKind::Hex8, n: [2, 2, 2] }.box_([1.0, 1.0, 1.0]);
    let text = write_stl_mesh(&m);
    assert!(text.starts_with("solid mesh\n"));
    let surface = m.surface();
    let facets = parse_stl(&text);
    assert_eq!(facets.len(), surface.triangles.len());
    assert_unit_outward_normals(&facets, [0.5, 0.5, 0.5]);
    assert_watertight(&surface.triangles);
}

#[test]
fn stl_gives_a_degenerate_triangle_a_zero_normal() {
    let tri = TriMesh { positions: vec![[0.0; 3]; 3], triangles: vec![[0, 1, 2]], ..Default::default() };
    let text = write_stl(&tri, "degenerate");
    assert!(text.contains("facet normal 0 0 0\n"), "{text}");
}

// ---------------------------------------------------------------- assembly

/// Every Set the structured builder names, as the engine's resolved Sets: a face Set carries
/// the nodes of its faces, which is what a Constraint on `xmin` wants.
fn sets_of(mesh: &Mesh) -> BTreeMap<String, ResolvedSet> {
    let mut sets = BTreeMap::new();
    for (name, faces) in &mesh.face_sets {
        let mut nodes: Vec<u32> = faces.iter().flat_map(|&f| mesh.face_nodes(f)).collect();
        nodes.sort_unstable();
        nodes.dedup();
        sets.insert(name.clone(), ResolvedSet { kind: SetKind::Face, faces: faces.clone(), nodes, elems: Vec::new() });
    }
    for (name, elems) in &mesh.elem_sets {
        let mut nodes: Vec<u32> = elems.iter().flat_map(|&e| mesh.elem_nodes(e).iter().copied()).collect();
        nodes.sort_unstable();
        nodes.dedup();
        sets.insert(
            name.clone(),
            ResolvedSet { kind: SetKind::Element, faces: Vec::new(), nodes, elems: elems.clone() },
        );
    }
    sets
}

/// A Problem over one Body of steel with the given Constraints.
fn problem<'a>(
    mesh: &'a Mesh,
    sets: &'a BTreeMap<String, ResolvedSet>,
    bodies: &'a [String],
    id: Idealisation,
    form: Formulation,
    constraints: Vec<Constraint>,
) -> Problem<'a> {
    Problem {
        mesh,
        sets,
        body_of_block: bodies,
        material_of_block: vec![Some(0); mesh.blocks.len()],
        materials: vec![steel()],
        section_of_block: vec![None; mesh.blocks.len()],
        sections: Vec::new(),
        idealisation: id,
        formulation: form,
        constraints,
        couplings: Vec::new(),
        points: Vec::new(),
        loads: Vec::new(),
        temperature: None,
        heat: false,
        heat_loads: Vec::new(),
    }
}

fn fix(name: &str, on: &str, dofs: [bool; 3], value: f64) -> Constraint {
    Constraint { name: name.into(), nodes: on.into(), dofs, value }
}

/// The `[8,2,2]` hex8 cantilever of Benchmark A4: 1 m × 0.1 m × 0.1 m of steel.
fn cantilever_mesh(n: [usize; 3], kind: ElementKind) -> Mesh {
    Structured { kind, n }.box_([1.0, 0.1, 0.1])
}

fn assemble(p: &Problem<'_>) -> (Pattern, Assembled) {
    let pat = pattern(p.mesh, p.dofs_per_node());
    let a = assemble_stiffness(p, &pat).expect("steel on a box assembles");
    (pat, a)
}

fn lcg_vec(n: usize, seed: u64) -> Vec<f64> {
    let mut r = Lcg(seed);
    (0..n).map(|_| 2.0 * r.unit() - 1.0).collect()
}

#[test]
fn the_pattern_is_structurally_symmetric_and_holds_every_coupling() {
    for kind in [ElementKind::Hex8, ElementKind::Tet4, ElementKind::Quad4] {
        let mesh = cantilever_mesh([3, 2, 2], kind);
        let dpn = mesh.dim;
        let pat = pattern(&mesh, dpn);
        let csr = &pat.csr;
        assert_eq!(csr.n, mesh.n_nodes() * dpn);
        assert_eq!(csr.nnz(), csr.col_idx.len());
        assert_eq!(csr.vals.len(), csr.nnz());
        for r in 0..csr.n {
            let row = &csr.col_idx[csr.row_ptr[r] as usize..csr.row_ptr[r + 1] as usize];
            assert!(row.windows(2).all(|w| w[0] < w[1]), "row {r} is not sorted and unique");
            for &c in row {
                let other = &csr.col_idx[csr.row_ptr[c as usize] as usize..csr.row_ptr[c as usize + 1] as usize];
                assert!(other.binary_search(&(r as u32)).is_ok(), "({r}, {c}) has no transpose");
            }
        }
        // every element coupling has a distinct slot, and every slot is inside the row it names
        for e in 0..mesh.n_elems() as u32 {
            let nd = mesh.kind_of(e).n_nodes() * dpn;
            let slot = &pat.slot[pat.slot_ptr[e as usize] as usize..pat.slot_ptr[e as usize + 1] as usize];
            assert_eq!(slot.len(), nd * nd);
            let conn = mesh.elem_nodes(e);
            for i in 0..nd {
                let row = conn[i / dpn] as usize * dpn + i % dpn;
                for j in 0..nd {
                    let at = slot[i * nd + j] as usize;
                    assert!(at >= csr.row_ptr[row] as usize && at < csr.row_ptr[row + 1] as usize);
                    assert_eq!(csr.col_idx[at] as usize, conn[j / dpn] as usize * dpn + j % dpn);
                }
            }
        }
    }
}

/// A4: `⟨K u, v⟩ = ⟨u, K v⟩` on the assembled operator, and `diag` agrees with the rows.
#[test]
fn the_assembled_operator_is_symmetric_and_its_diagonal_is_positive() {
    let mesh = cantilever_mesh([8, 2, 2], ElementKind::Hex8);
    let sets = sets_of(&mesh);
    let bodies = vec!["beam".to_string()];
    let p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::IncompatibleModes, vec![]);
    let (_, a) = assemble(&p);
    assert!(a.min_det_j > 0.0);
    assert_eq!(a.f_thermal.iter().filter(|x| **x != 0.0).count(), 0, "no temperature, no thermal load");
    let n = a.k.n;
    let mut ku = vec![0.0; n];
    let mut kv = vec![0.0; n];
    for pair in 0..5 {
        let u = lcg_vec(n, 11 + pair);
        let v = lcg_vec(n, 101 + pair);
        a.k.spmv(&u, &mut ku);
        a.k.spmv(&v, &mut kv);
        let left: f64 = ku.iter().zip(&v).map(|(a, b)| a * b).sum();
        let right: f64 = kv.iter().zip(&u).map(|(a, b)| a * b).sum();
        assert!((left - right).abs() <= 1e-12 * left.abs().max(1.0), "{left} vs {right}");
    }
    let diag = a.k.diag();
    assert_eq!(diag.len(), n);
    assert!(diag.iter().all(|&d| d > 0.0), "a stiffness diagonal is positive");
    for (r, d) in diag.iter().enumerate() {
        let row = &a.k.col_idx[a.k.row_ptr[r] as usize..a.k.row_ptr[r + 1] as usize];
        let at = row.binary_search(&(r as u32)).expect("the pattern has a diagonal");
        assert_eq!(*d, a.k.vals[a.k.row_ptr[r] as usize + at]);
    }
    // a matrix without a diagonal entry reports zero there
    let empty = Csr { n: 2, row_ptr: vec![0, 0, 0], col_idx: vec![], vals: vec![] };
    assert_eq!(empty.diag(), vec![0.0, 0.0]);
}

/// A8, the numerics half: the same assembly at 1 and N threads, bit for bit.
#[test]
fn assembly_is_bit_identical_at_one_and_many_threads() {
    let mesh = cantilever_mesh([6, 3, 3], ElementKind::Hex8);
    let sets = sets_of(&mesh);
    let bodies = vec!["beam".to_string()];
    let p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::IncompatibleModes, vec![]);
    let many = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).max(2);
    let one = Pool::new(1).install(|| assemble(&p).1.k.vals);
    let par = Pool::new(many).install(|| assemble(&p).1.k.vals);
    assert_eq!(one.len(), par.len());
    let differing = one.iter().zip(&par).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
    assert_eq!(differing, 0, "{differing} of {} values differ at {many} threads", one.len());
}

/// Reduce, expand and the reactions on a bar pulled by a prescribed end displacement, against
/// the closed form `σ = E δ / L`, `R = σ A`.
#[test]
fn reduce_expand_and_reactions_recover_the_uniaxial_bar() {
    let mesh = cantilever_mesh([4, 1, 1], ElementKind::Hex8);
    let sets = sets_of(&mesh);
    let bodies = vec!["bar".to_string()];
    let delta = 1e-4;
    let p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::IncompatibleModes,
        vec![
            fix("root", "xmin", [true, false, false], 0.0),
            fix("sym_y", "ymin", [false, true, false], 0.0),
            fix("sym_z", "zmin", [false, false, true], 0.0),
            fix("pull", "xmax", [true, false, false], delta),
        ],
    );
    let (_, a) = assemble(&p);
    let rc = resolve(&p).expect("no conflict");
    assert_eq!(rc.fixed.len(), rc.owner.len());
    let f = vec![0.0; a.k.n];
    let red = reduce(&a.k, &f, &rc, &[]);
    assert_eq!(red.free.len() + red.fixed.len(), a.k.n);
    assert_eq!(red.k_ff.n, red.free.len());
    assert!(red.f_f.iter().any(|x| *x != 0.0), "the prescribed end loads the free rows");
    // solve K_ff u_f = f_f by dense Cholesky and check the bar's uniform strain
    let mut dense = vec![0.0; red.k_ff.n * red.k_ff.n];
    for r in 0..red.k_ff.n {
        for e in red.k_ff.row_ptr[r] as usize..red.k_ff.row_ptr[r + 1] as usize {
            dense[r * red.k_ff.n + red.k_ff.col_idx[e] as usize] = red.k_ff.vals[e];
        }
    }
    let u_f = spd_solve(&dense, red.k_ff.n, &red.f_f);
    let u = expand(&red, &u_f);
    // the exact constant-strain answer: u = (delta x, -nu delta y, -nu delta z)
    for node in 0..mesh.n_nodes() {
        let x = mesh.node(node as u32);
        let want = [delta * x[0], -POISSON * delta * x[1], -POISSON * delta * x[2]];
        for c in 0..3 {
            assert!((u[3 * node + c] - want[c]).abs() <= 1e-9 * delta, "node {node} component {c}");
        }
    }
    let r = reactions(&a.k, &u, &f, &red.fixed, &Mpc::none());
    let total: f64 = red.fixed.iter().map(|&d| if d % 3 == 0 { r[d as usize] } else { 0.0 }).sum();
    assert!(total.abs() <= 1e-9 * (YOUNG * delta * 0.01), "reactions cancel: {total}");
    let root: f64 = sets["xmin"].nodes.iter().map(|&n| r[3 * n as usize]).sum();
    let expected = -YOUNG * delta / 1.0 * 0.01;
    assert!((root - expected).abs() <= 1e-8 * expected.abs(), "root reaction {root} vs {expected}");
    // every unconstrained DOF carries no reaction
    assert!(red.free.iter().all(|&d| r[d as usize] == 0.0));
}

#[test]
fn two_constraints_that_disagree_on_one_dof_are_a_conflict() {
    let mesh = cantilever_mesh([2, 1, 1], ElementKind::Hex8);
    let sets = sets_of(&mesh);
    let bodies = vec!["bar".to_string()];
    let same = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("a", "xmin", [true, false, false], 0.0), fix("b", "xmin", [true, true, false], 0.0)],
    );
    assert!(resolve(&same).is_ok(), "the same value twice is not a conflict");
    let clash = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("a", "xmin", [true, false, false], 0.0), fix("b", "xmin", [true, false, false], 1e-3)],
    );
    let e = resolve(&clash).expect_err("two values on one DOF");
    assert_eq!(e.code, ErrorCode::ConstraintConflict);
    assert!(e.cause.contains("'a' and 'b'") && e.cause.contains("ux"), "{}", e.cause);
    assert_eq!(e.where_.as_deref(), Some("constraint 'b'"));
    let missing = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("a", "nowhere", [true, false, false], 0.0)],
    );
    let e = resolve(&missing).expect_err("an unknown set");
    assert_eq!(e.code, ErrorCode::SetEmpty);
}

#[test]
fn a_block_without_a_material_names_its_body_and_a_temperature_reaches_the_element() {
    let mesh = cantilever_mesh([2, 1, 1], ElementKind::Hex8);
    let sets = sets_of(&mesh);
    let bodies = vec!["beam".to_string()];
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, vec![]);
    p.material_of_block = vec![None];
    let e = p.material_of(0).map(|_| ()).expect_err("no material");
    assert_eq!(e.code, ErrorCode::ModelNoMaterial);
    assert_eq!(e.where_.as_deref(), Some("body 'beam'"));
    let pat = pattern(&mesh, 3);
    assert_eq!(assemble_stiffness(&p, &pat).expect_err("no material").code, ErrorCode::ModelNoMaterial);

    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, vec![]);
    let dt = 80.0;
    p.temperature = Some((vec![dt; mesh.n_nodes()], 0.0));
    let mut t = vec![0.0; 8];
    p.gather_temperature(0, &mut t);
    assert_eq!(t, vec![dt; 8]);
    let coords = vec![0.0; 24];
    assert_eq!(p.ctx(0, &coords, &t).expect("material").t_ref, 0.0);
    let a = assemble_stiffness(&p, &pat).expect("assembles with a temperature");
    // free thermal expansion: Σ f_thermal balances over the body (no net force)
    for c in 0..3 {
        let net: f64 = (0..mesh.n_nodes()).map(|n| a.f_thermal[3 * n + c]).sum();
        assert!(net.abs() <= 1e-6, "component {c} of the thermal load nets {net}");
    }
    assert!(a.f_thermal.iter().any(|x| x.abs() > 1.0), "and it is not all zero");
}

#[test]
fn a_folded_element_stops_assembly_and_names_itself() {
    let mut mesh = cantilever_mesh([2, 1, 1], ElementKind::Hex8);
    // mirror the second element's far face back through the first: det J goes negative
    let far: Vec<u32> = mesh.node_sets["xmax"].clone();
    for n in far {
        mesh.coords[3 * n as usize] = -1.0;
    }
    let sets = sets_of(&mesh);
    let bodies = vec!["beam".to_string()];
    let p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, vec![]);
    let pat = pattern(&mesh, 3);
    let e = assemble_stiffness(&p, &pat).expect_err("a folded element");
    assert_eq!(e.code, ErrorCode::MeshInverted);
    assert_eq!(e.where_.as_deref(), Some("element 1"));
}

/// The chunk length falls with the element size and never below one element.
#[test]
fn the_assembly_chunk_shrinks_with_the_element_and_the_faer_view_is_the_same_arrays() {
    let mesh = cantilever_mesh([2, 2, 2], ElementKind::Hex20);
    let sets = sets_of(&mesh);
    let bodies = vec!["beam".to_string()];
    let p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, vec![]);
    let (_, a) = assemble(&p);
    let f = a.k.as_faer();
    assert_eq!(f.nrows(), a.k.n);
    assert_eq!(f.ncols(), a.k.n);
    assert_eq!(f.val().len(), a.k.nnz());
}

// ---------------------------------------------------- solvers, checks, procedures

fn nop(_p: Progress) -> bool {
    true
}

/// A progress callback that cancels on call `at` and accepts every other call.
fn cancel_on(at: usize) -> impl FnMut(Progress) -> bool {
    let mut i = 0;
    move |_p| {
        i += 1;
        i - 1 != at
    }
}

/// A static Step with the settings an amplitude would read, and no amplitude: the single
/// solve `Step::Static` has always been.
fn static_step(solver: SolveOptions) -> Step {
    Step::Static { solver, dt: 1.0, t_end: 1.0, amplitude: None, output_every: 1 }
}

fn run_static(p: &Problem<'_>, progress: OnProgress<'_>) -> Result<StepResult, Error> {
    pollster::block_on(procedure::run(p, &static_step(SolveOptions::default()), &Pool::new(2), None, None, progress))
}

/// A7: the reactions must balance the applied load, on every structural case.
///
/// `scale` is the characteristic force of the case. A case driven by a prescribed displacement
/// or by a temperature has no applied load at all, and "1e-9 relative to zero" is not a test;
/// the forces that actually flow through the model are what the residual is measured against.
fn reaction_balance(res: &StepResult, applied: [f64; 3], scale: f64) {
    let r = &res.fields[&Field::Reaction];
    let mut sum = [0.0; 3];
    for i in 0..r.len() {
        for (c, s) in sum.iter_mut().enumerate() {
            *s += r.data[i * 3 + c];
        }
    }
    let scale = applied.iter().fold(scale.abs(), |m, x| m.max(x.abs()));
    for (c, s) in sum.iter().enumerate() {
        assert!((s + applied[c]).abs() <= 1e-9 * scale, "component {c}: reactions {s}, applied {}", applied[c]);
    }
}

/// The mesh every patch test runs on: a 2 × 2 × 2 lattice of the kind with its interior nodes
/// pushed off the grid, so the element must reproduce a linear field on a distorted shape.
/// `x` starts at 1 so the axisymmetric radius is never zero.
fn patch_mesh(kind: ElementKind) -> Mesh {
    let n = if kind.dim() == 3 { [2, 2, 2] } else { [2, 2, 1] };
    let mut m = Structured { kind, n }.build(|p| [1.0 + p[0], p[1], p[2]]);
    perturb_interior(&mut m, 0.075, 7);
    straighten(&mut m);
    m
}

/// Put every mid-edge node back at the midpoint of its (possibly moved) corners.
///
/// A quadratic element with curved edges has a non-constant Jacobian, and its quadrature rule
/// is exact only to the rule's degree, so the *patch* identity `Σ_e ∫ ∂N_a/∂x dV = 0` no longer
/// holds exactly at an interior node. Straight-sided elements are what the patch test is
/// about, and both hexahedra and tetrahedra keep their distorted corners.
fn straighten(m: &mut Mesh) {
    let blocks = m.blocks.clone();
    for blk in &blocks {
        let (nn, nc) = (blk.kind.n_nodes(), blk.kind.n_corners());
        if nn == nc {
            continue;
        }
        for en in blk.conn.chunks_exact(nn) {
            for (i, &[a, b]) in blk.kind.edges().iter().enumerate() {
                let (pa, pb) = (m.node(en[a as usize]), m.node(en[b as usize]));
                let mid = en[nc + i] as usize;
                for k in 0..3 {
                    m.coords[3 * mid + k] = 0.5 * (pa[k] + pb[k]);
                }
            }
        }
    }
}

/// `u = ε · x` on every node of a mesh.
fn patch_mesh_field(mesh: &Mesh, id: &Idealisation, e: &[f64; VOIGT]) -> Vec<f64> {
    let three = mesh.dim == 3;
    let mut v = vec![0.0; mesh.n_nodes() * mesh.dim];
    for n in 0..mesh.n_nodes() {
        let d = patch_u(id, three, e, mesh.node(n as u32));
        for i in 0..mesh.dim {
            v[n * mesh.dim + i] = d[i];
        }
    }
    v
}

/// Every DOF of every boundary node, with the value the exact field takes there. The DOF
/// stride is read off `exact`, so a one-component temperature field works as well.
fn boundary_constraints(mesh: &Mesh, exact: &[f64]) -> ResolvedConstraints {
    let dpn = exact.len() / mesh.n_nodes();
    let mut nodes: Vec<u32> = mesh.boundary_faces().iter().flat_map(|&f| mesh.face_nodes(f)).collect();
    nodes.sort_unstable();
    nodes.dedup();
    let fixed: Vec<(u32, f64)> = nodes
        .iter()
        .flat_map(|&n| (0..dpn).map(move |c| n * dpn as u32 + c as u32))
        .map(|d| (d, exact[d as usize]))
        .collect();
    let owner = vec![0; fixed.len()];
    ResolvedConstraints { fixed, owner }
}

/// A1: every kind reproduces every constant-strain state exactly on a distorted mesh — the
/// interior displacements and every Gauss-point stress.
#[test]
fn the_patch_test_passes_for_every_kind_and_every_constant_strain_mode() {
    for kind in ALL_KINDS {
        let mesh = patch_mesh(kind);
        let sets = sets_of(&mesh);
        for id in idealisations(kind) {
            // In axisymmetry a constant γ_rz is not an equilibrium state — it needs the body
            // force σ_rz/r — so the mesh patch test drops it; the single-element test, where
            // every node is prescribed, still covers it.
            let axi = matches!(id, Idealisation::Axisymmetric);
            let modes: Vec<[f64; VOIGT]> =
                patch_modes(&id).into_iter().enumerate().filter(|(i, _)| !(axi && *i == 2)).map(|(_, e)| e).collect();
            for e in modes {
                patch_check(&mesh, &sets, &id, &e, &format!("{kind:?} {id:?}"));
            }
        }
    }
}

/// The patch test on one mesh and one constant-strain mode: with the exact linear field
/// prescribed on every boundary DOF, every interior DOF and every Gauss-point stress must be
/// exact to 1e-10 relative. `label` names the case in a failure.
fn patch_check(mesh: &Mesh, sets: &BTreeMap<String, ResolvedSet>, id: &Idealisation, e: &[f64; VOIGT], label: &str) {
    let bodies = vec!["patch".to_string()];
    let p = problem(
        mesh,
        sets,
        &bodies,
        id.clone(),
        Formulation::IncompatibleModes,
        vec![fix("edge", "all", [true, true, true], 0.0)],
    );
    let pat = pattern(mesh, mesh.dim);
    let a = assemble_stiffness(&p, &pat).expect("a patch mesh assembles");
    let exact = patch_mesh_field(mesh, id, e);
    let rc = boundary_constraints(mesh, &exact);
    let red = reduce(&a.k, &vec![0.0; a.k.n], &rc, &[]);
    let (u_f, info) =
        pollster::block_on(solve(&red.k_ff, &red.f_f, &SolveOptions::default(), &Pool::new(2), None, &mut nop))
            .expect("the patch system is positive definite");
    assert!(info.rel_residual < 1e-10, "{label}: residual {}", info.rel_residual);
    let u = expand(&red, &u_f);
    let scale = exact.iter().fold(0.0f64, |m, x| m.max(x.abs()));
    for (i, (got, want)) in u.iter().zip(&exact).enumerate() {
        assert!((got - want).abs() <= 1e-10 * scale, "{label} dof {i}: {got} vs {want}");
    }
    // and the stress at every Gauss point is D ε
    let want = expected_stress(id, e);
    let sscale = want.iter().fold(0.0f64, |m, x| m.max(x.abs()));
    let mut coords = Vec::new();
    for elem in 0..mesh.n_elems() as u32 {
        let kind = mesh.kind_of(elem);
        let el = element_for(kind);
        let (nn, n_gp) = (kind.n_nodes(), el.n_gp());
        coords.resize(nn * 3, 0.0);
        mesh.elem_coords(elem, &mut coords);
        let mut ue: Vec<f64> = Vec::with_capacity(nn * mesh.dim);
        for &n in mesh.elem_nodes(elem) {
            for c in 0..mesh.dim {
                ue.push(u[n as usize * mesh.dim + c]);
            }
        }
        let c = ctx(&coords, &p.materials[0], id.clone(), Formulation::IncompatibleModes);
        let (mut sig, mut eps) = (vec![0.0; n_gp * VOIGT], vec![0.0; n_gp * VOIGT]);
        el.recover(&c, &ue, &mut sig, &mut eps).expect("recover");
        for g in 0..n_gp {
            for i in 0..VOIGT {
                let got = sig[g * VOIGT + i];
                assert!(
                    (got - want[i]).abs() <= 1e-10 * sscale,
                    "{label} element {elem} gp {g} component {i}: {got} vs {}",
                    want[i]
                );
            }
        }
    }
}

/// The bar of Benchmark A5 for one kind: 1 m long, 0.1 × 0.1 in section, stretched by a
/// prescribed end displacement against three symmetry planes.
fn uniaxial_bar(kind: ElementKind) -> (Mesh, Idealisation, f64) {
    let n = [10, 1, 1];
    let mesh = Structured { kind, n }.box_([1.0, 0.1, 0.1]);
    let id = if kind.dim() == 3 { Idealisation::Solid3d } else { Idealisation::PlaneStress { thickness: 0.1 } };
    (mesh, id, 0.01)
}

/// A5 and A7: `σ = F/A`, `δ = F L / (E A)` and reactions that balance, for all eight kinds.
#[test]
fn the_uniaxial_bar_gives_f_over_a_and_balanced_reactions_for_every_kind() {
    let delta = 2e-4;
    for kind in ALL_KINDS {
        let (mesh, id, area) = uniaxial_bar(kind);
        let sets = sets_of(&mesh);
        let bodies = vec!["bar".to_string()];
        let mut constraints: Vec<Constraint> = vec![
            fix("root", "xmin", [true, false, false], 0.0),
            fix("sym_y", "ymin", [false, true, false], 0.0),
            fix("pull", "xmax", [true, false, false], delta),
        ];
        if kind.dim() == 3 {
            constraints.push(fix("sym_z", "zmin", [false, false, true], 0.0));
        }
        let p = problem(&mesh, &sets, &bodies, id, Formulation::IncompatibleModes, constraints);
        let res = run_static(&p, &mut nop).expect("the bar solves");
        // δ = F L / (E A) with L = 1, so F = E A δ
        let force = YOUNG * area * delta;
        let u = &res.fields[&Field::Displacement];
        for &n in &sets["xmax"].nodes {
            assert!((u.data[n as usize * 3] - delta).abs() <= 1e-12, "{kind:?}");
        }
        let rc = resolve(&p).expect("no conflict");
        let per = reactions_per_constraint(&p, &rc, &res.fields[&Field::Reaction]);
        let root = per.iter().find(|(n, _)| n == "root").expect("the root constraint").1;
        assert!((root[0] + force).abs() <= 1e-8 * force, "{kind:?}: root reaction {} vs {}", root[0], -force);
        reaction_balance(&res, [0.0; 3], force);
        assert!(res.scalars["min_det_j"] > 0.0);
        assert_eq!(res.solver.solver, "cpu-direct");
        assert!(res.warnings.is_empty());
    }
}

/// A2 at the assembled level: nothing but the Constraints removes a rigid mode, and the check
/// names the one a single fixed node leaves free.
#[test]
fn the_rigid_mode_check_names_the_rotation_a_single_fixed_node_leaves_free() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [4, 2, 2] }.box_([1.0, 0.1, 0.1]);
    // the node at the centre of the root face: rotation about x leaves it exactly where it is
    let node = (0..mesh.n_nodes() as u32)
        .find(|&n| mesh.node(n) == [0.0, 0.05, 0.05])
        .expect("the [4,2,2] grid has a node at the centre of xmin");
    let mut sets = sets_of(&mesh);
    sets.insert(
        "pin".to_string(),
        ResolvedSet { kind: SetKind::Node, faces: Vec::new(), nodes: vec![node], elems: Vec::new() },
    );
    let bodies = vec!["bar".to_string()];
    let p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("pin", "pin", [true, true, true], 0.0)],
    );
    let e = run_static(&p, &mut nop).expect_err("a pinned bar still spins");
    assert_eq!(e.code, ErrorCode::ConstraintRigidModes);
    assert!(e.cause.contains("rotation about x"), "{}", e.cause);
    assert_eq!(e.suggestion.as_deref(), Some("constraint.fix on a Set that removes it"));
    // nothing constrained at all: every mode is free, translations included
    let free = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, vec![]);
    let e = run_static(&free, &mut nop).expect_err("nothing holds it");
    assert!(e.cause.contains("translation x") && e.cause.contains("rotation about z"), "{}", e.cause);
}

/// The 2D rigid basis is two translations and the rotation about z.
#[test]
fn a_plane_model_has_three_rigid_modes() {
    let mesh = Structured { kind: ElementKind::Quad4, n: [2, 2, 1] }.box_([1.0, 1.0, 0.0]);
    let sets = sets_of(&mesh);
    let bodies = vec!["sheet".to_string()];
    let free = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::PlaneStrain,
        Formulation::Full,
        vec![fix("edge", "xmin", [true, false, false], 0.0)],
    );
    let e = run_static(&free, &mut nop).expect_err("a sheet held only in x still slides");
    assert_eq!(e.code, ErrorCode::ConstraintRigidModes);
    // holding a whole edge in x removes the x translation and the rotation with it
    assert_eq!(e.cause, "the model can still move as a rigid body: translation y");

    // one node held in both components leaves exactly the rotation about z
    let node = (0..mesh.n_nodes() as u32).find(|&n| mesh.node(n) == [0.5, 0.5, 0.0]).expect("the centre node");
    let mut pinned = sets.clone();
    pinned.insert(
        "pin".to_string(),
        ResolvedSet { kind: SetKind::Node, faces: Vec::new(), nodes: vec![node], elems: Vec::new() },
    );
    let p = problem(
        &mesh,
        &pinned,
        &bodies,
        Idealisation::PlaneStrain,
        Formulation::Full,
        vec![fix("pin", "pin", [true, true, false], 0.0)],
    );
    let e = run_static(&p, &mut nop).expect_err("a sheet on a pin still turns");
    assert_eq!(e.cause, "the model can still move as a rigid body: rotation about z");
}

#[test]
fn every_well_posedness_check_has_a_failing_input() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [2, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let mut sets = sets_of(&mesh);
    sets.insert(
        "void".to_string(),
        ResolvedSet { kind: SetKind::Node, faces: Vec::new(), nodes: Vec::new(), elems: Vec::new() },
    );
    let bodies = vec!["bar".to_string()];
    let held = || {
        vec![
            fix("root", "xmin", [true, true, true], 0.0),
            fix("sym", "ymin", [false, true, false], 0.0),
            fix("top", "zmin", [false, false, true], 0.0),
        ]
    };
    // a well-posed Problem passes every check
    let good = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, held());
    assert!(checks::all(&good).is_empty());

    let mut no_mat = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, held());
    no_mat.material_of_block = vec![None];
    assert_eq!(checks::all(&no_mat)[0].code, ErrorCode::ModelNoMaterial);
    let explicit = Step::Explicit { t_end: 1e-3, dt_factor: 0.9, initial_velocity: None, output_every: 1 };
    assert_eq!(
        run_step(&no_mat, &explicit).expect_err("the procedure runs the checks").code,
        ErrorCode::ModelNoMaterial
    );

    let mut empty = held();
    empty.push(fix("nothing", "void", [true, false, false], 0.0));
    let empty = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, empty);
    assert_eq!(checks::all(&empty)[0].code, ErrorCode::SetEmpty);

    let mut clash = held();
    clash.push(fix("other", "xmin", [true, false, false], 1e-3));
    let clash = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, clash);
    let codes: Vec<ErrorCode> = checks::all(&clash).iter().map(|e| e.code).collect();
    assert_eq!(codes, [ErrorCode::ConstraintConflict], "a conflict hides the rigid-mode test");

    let mut folded = mesh.clone();
    for &n in &folded.node_sets["xmax"].clone() {
        folded.coords[3 * n as usize] = -1.0;
    }
    let fsets = sets_of(&folded);
    let bad = problem(&folded, &fsets, &bodies, Idealisation::Solid3d, Formulation::Full, held());
    let e = checks::all(&bad).into_iter().find(|e| e.code == ErrorCode::MeshInverted).expect("folded");
    assert!(e.cause.contains("det J is not positive"), "{}", e.cause);
    assert_eq!(e.where_.as_deref(), Some("element 1"));
    // an empty mesh has no worst element to report
    let bare = Mesh {
        dim: 3,
        coords: Vec::new(),
        blocks: Vec::new(),
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::new(),
        face_sets: BTreeMap::new(),
    };
    let bsets = sets_of(&bare);
    let none = problem(&bare, &bsets, &[], Idealisation::Solid3d, Formulation::Full, Vec::new());
    assert!(checks::all(&none).iter().all(|e| e.code != ErrorCode::MeshInverted));
}

#[test]
fn a_host_that_says_stop_cancels_at_every_phase() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [2, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = vec!["bar".to_string()];
    let p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![
            fix("root", "xmin", [true, true, true], 0.0),
            fix("sym", "ymin", [false, true, false], 0.0),
            fix("top", "zmin", [false, false, true], 0.0),
        ],
    );
    for at in 0..3 {
        let mut stop = cancel_on(at);
        let e = run_static(&p, &mut stop).expect_err("cancelled");
        assert_eq!(e.code, ErrorCode::Cancelled, "phase {at}");
    }
    let mut go = cancel_on(99);
    assert!(run_static(&p, &mut go).is_ok());
}

#[test]
fn the_gpu_solver_needs_a_gpu_and_every_procedure_names_itself() {
    // `gpu-pcg` without a device is not a panic and not a silent fall-back to the CPU: it names
    // the two solvers that do work here.
    let k = Csr { n: 1, row_ptr: vec![0, 1], col_idx: vec![0], vals: vec![2.0] };
    let opts = SolveOptions { solver: Solver::GpuPcg, ..SolveOptions::default() };
    let e = pollster::block_on(solve(&k, &[1.0], &opts, &Pool::new(2), None, &mut nop)).expect_err("no adapter");
    assert_eq!(e.code, ErrorCode::Unsupported);
    assert_eq!(e.cause, "no GPU adapter; use cpu-pcg or cpu-direct");
    assert_eq!(e.suggestion.as_deref(), Some("solve.run { solver: 'cpu-pcg' }"));
    assert_eq!(solver_name(Solver::CpuDirect), "cpu-direct");

    let opts = SolveOptions::default();
    let names: Vec<&str> = [
        static_step(opts),
        Step::StaticNonlinear(nl_options(1)),
        Step::Modal { n_modes: 3, shift: None, solver: opts },
        Step::HeatSteady { solver: opts, control: NonlinearControl::default() },
        Step::HeatTransient {
            dt: 1.0,
            t_end: 2.0,
            theta: 0.5,
            initial: 0.0,
            output_every: 1,
            amplitude: None,
            solver: opts,
            control: NonlinearControl::default(),
        },
        Step::Explicit { t_end: 1.0, dt_factor: 0.9, initial_velocity: None, output_every: 1 },
        implicit_step(1.0, 2.0, 0.0, (0.0, 0.0), None, 1),
        harmonic_step(1.0, 2.0, 3, 0.02, 1),
    ]
    .iter()
    .map(Step::name)
    .collect();
    assert_eq!(
        names,
        ["static", "static-nonlinear", "modal", "heat-steady", "heat-transient", "explicit", "implicit", "harmonic"]
    );
}

/// The checks pass but the material does not: a law given the wrong number of properties
/// fails inside the element integral, and the procedure reports it as it is.
#[test]
fn a_material_the_checks_cannot_see_still_stops_the_procedure() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [2, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = vec!["bar".to_string()];
    let mut p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![
            fix("root", "xmin", [true, true, true], 0.0),
            fix("sym", "ymin", [false, true, false], 0.0),
            fix("top", "zmin", [false, false, true], 0.0),
        ],
    );
    assert!(checks::all(&p).is_empty(), "the well-posedness checks never look at the props");
    p.materials[0].props = vec![YOUNG];
    let e = run_static(&p, &mut nop).expect_err("a law with one prop instead of two");
    assert_eq!(e.code, ErrorCode::MaterialProps);
}

#[test]
fn an_indefinite_matrix_is_not_positive_definite() {
    // [[1, 2], [2, 1]] is symmetric but indefinite: Cholesky hits a non-positive pivot
    let k = Csr { n: 2, row_ptr: vec![0, 2, 4], col_idx: vec![0, 1, 0, 1], vals: vec![1.0, 2.0, 2.0, 1.0] };
    let e = pollster::block_on(solve(&k, &[1.0, 1.0], &SolveOptions::default(), &Pool::new(2), None, &mut nop))
        .expect_err("indefinite");
    assert_eq!(e.code, ErrorCode::SolveNotPositiveDefinite);
    assert_eq!(e.suggestion.as_deref(), Some("constraint.fix"));
    assert_eq!(e.where_.as_deref(), Some("solve"));
}

/// The reduced system `K_ff u = f_f` of a Problem, which is what every solver actually sees.
fn reduced_system(p: &Problem<'_>) -> (Csr, Vec<f64>) {
    let (_, a) = assemble(p);
    let mut f = a.f_thermal.clone();
    assemble_loads(p, &mut f).expect("the loads of these cases assemble");
    let rc = resolve(p).expect("no conflict");
    let red = reduce(&a.k, &f, &rc, &[]);
    (red.k_ff, red.f_f)
}

/// A5 and B1 through `cpu-pcg` inside the f64 refinement loop: the same answer as the direct
/// factorisation, to the tolerance the refinement was asked for.
#[test]
fn the_conjugate_gradient_inside_refinement_reaches_the_direct_answer() {
    let cases: [([usize; 3], Vec<Load>); 2] = [
        ([10, 1, 1], vec![Load::Traction { faces: "xmax".into(), t: [1e5, 0.0, 0.0] }]),
        ([8, 2, 2], vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -1e5] }]),
    ];
    for (n, loads) in cases {
        let mesh = cantilever_mesh(n, ElementKind::Hex8);
        let sets = sets_of(&mesh);
        let bodies = vec!["beam".to_string()];
        let mut p = problem(
            &mesh,
            &sets,
            &bodies,
            Idealisation::Solid3d,
            Formulation::IncompatibleModes,
            vec![fix("root", "xmin", [true, true, true], 0.0)],
        );
        p.loads = loads;
        let (k, f) = reduced_system(&p);
        let pool = Pool::new(2);
        let direct = SolveOptions { solver: Solver::CpuDirect, ..SolveOptions::default() };
        let (want, _) = pollster::block_on(solve(&k, &f, &direct, &pool, None, &mut nop)).expect("direct");
        let opts = SolveOptions { solver: Solver::CpuPcg, ..SolveOptions::default() };
        let (got, info) = pollster::block_on(solve(&k, &f, &opts, &pool, None, &mut nop)).expect("cpu-pcg");
        assert_eq!(info.solver, "cpu-pcg");
        assert!(info.rel_residual < opts.rel_tol, "{n:?}: residual {}", info.rel_residual);
        let scale = want.iter().fold(0.0f64, |m, x| m.max(x.abs()));
        for (i, (a, b)) in got.iter().zip(&want).enumerate() {
            assert!((a - b).abs() <= 1e-10 * scale, "{n:?} dof {i}: {a} vs {b}");
        }
        println!("cpu-pcg on {n:?}: {} equations, {} refinement steps", k.n, info.iterations);
    }
}

/// An inner solve that never makes progress is a stall, not an infinite loop — twice over: a
/// budget that runs out, and a residual that stops halving before it does.
#[test]
fn refinement_that_gets_nowhere_reports_a_stall_and_names_the_way_out() {
    let mesh = cantilever_mesh([4, 1, 1], ElementKind::Hex8);
    let sets = sets_of(&mesh);
    let bodies = vec!["beam".to_string()];
    let mut p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::IncompatibleModes,
        vec![fix("root", "xmin", [true, true, true], 0.0)],
    );
    p.loads = vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -1e5] }];
    let (k, f) = reduced_system(&p);
    let pool = Pool::new(2);
    // one inner iteration and one outer step: the budget runs out
    let budget = SolveOptions { solver: Solver::CpuPcg, max_iterations: 1, max_outer: 1, ..SolveOptions::default() };
    let e = pollster::block_on(solve(&k, &f, &budget, &pool, None, &mut nop)).expect_err("nowhere near 1e-10");
    assert_eq!(e.code, ErrorCode::SolveStalled);
    assert_eq!(e.where_.as_deref(), Some("solve"));
    assert_eq!(e.suggestion.as_deref(), Some("solve.run { solver: 'cpu-direct' }"));
    assert!(e.cause.contains("budget ran out"), "{}", e.cause);
    // no inner iterations at all: the correction is zero and the residual never halves
    let stuck = SolveOptions { solver: Solver::CpuPcg, max_iterations: 0, ..SolveOptions::default() };
    let e = pollster::block_on(solve(&k, &f, &stuck, &pool, None, &mut nop)).expect_err("no progress");
    assert_eq!(e.code, ErrorCode::SolveStalled);
    assert!(e.cause.contains("stopped halving"), "{}", e.cause);
    // A residual that stops falling *near* the target is the f64 floor of `b − K x`, not a
    // failure: the answer stands and the Result reports the residual it really reached. On
    // `[[2,1],[1,2]] x = [1,0]` one Jacobi-CG step lands at exactly ‖r‖/‖b‖ = 0.5, which is
    // inside a hundred times a tolerance of 1e-2 and outside a hundred times one of 1e-4.
    let two = Csr { n: 2, row_ptr: vec![0, 2, 4], col_idx: vec![0, 1, 0, 1], vals: vec![2.0, 1.0, 1.0, 2.0] };
    let one_step = SolveOptions {
        solver: Solver::CpuPcg,
        rel_tol: 1e-2,
        max_iterations: 1,
        max_outer: 1,
        ..SolveOptions::default()
    };
    let (x, info) = pollster::block_on(solve(&two, &[1.0, 0.0], &one_step, &pool, None, &mut nop)).expect("the floor");
    assert_eq!(info.rel_residual, 0.5);
    assert_eq!(x, vec![0.5, 0.0]);
    let too_far = SolveOptions { rel_tol: 1e-4, ..one_step };
    let e = pollster::block_on(solve(&two, &[1.0, 0.0], &too_far, &pool, None, &mut nop)).expect_err("far off");
    assert_eq!(e.code, ErrorCode::SolveStalled);
    // and a host that says stop between refinement steps is obeyed
    for at in 0..2 {
        let mut stop = cancel_on(at);
        let opts = SolveOptions { solver: Solver::CpuPcg, ..SolveOptions::default() };
        let e = pollster::block_on(solve(&k, &f, &opts, &pool, None, &mut stop)).expect_err("cancelled");
        assert_eq!(e.code, ErrorCode::Cancelled, "call {at}");
    }
}

/// The conjugate gradient needs positive curvature; a matrix without it says so instead of
/// wandering. Both the indefinite case and the one whose diagonal gives no preconditioner.
#[test]
fn the_conjugate_gradient_refuses_a_matrix_that_is_not_positive_definite() {
    let opts = SolveOptions { solver: Solver::CpuPcg, ..SolveOptions::default() };
    let indefinite = Csr { n: 2, row_ptr: vec![0, 2, 4], col_idx: vec![0, 1, 0, 1], vals: vec![1.0, 2.0, 2.0, 1.0] };
    let no_diagonal = Csr { n: 2, row_ptr: vec![0, 1, 2], col_idx: vec![1, 0], vals: vec![1.0, 1.0] };
    for k in [indefinite, no_diagonal] {
        let e = pollster::block_on(solve(&k, &[1.0, -1.0], &opts, &Pool::new(2), None, &mut nop))
            .expect_err("not positive definite");
        assert_eq!(e.code, ErrorCode::SolveNotPositiveDefinite);
        assert!(e.cause.contains("pᵀKp"), "{}", e.cause);
        assert_eq!(e.suggestion.as_deref(), Some("constraint.fix"));
    }
}

/// `Auto` is a policy on the size of the system and whether the host granted a device, and it
/// is tested at both sides of the threshold without needing either.
#[test]
fn auto_picks_the_direct_solver_until_the_factor_stops_fitting() {
    use femlab_engine::solve::DIRECT_MAX_DOFS;
    assert_eq!(DIRECT_MAX_DOFS, 200_000, "the native threshold; wasm32 takes half");
    for gpu in [false, true] {
        assert_eq!(resolve_solver(Solver::Auto, DIRECT_MAX_DOFS, gpu), Solver::CpuDirect);
    }
    assert_eq!(resolve_solver(Solver::Auto, DIRECT_MAX_DOFS + 1, false), Solver::CpuPcg);
    assert_eq!(resolve_solver(Solver::Auto, DIRECT_MAX_DOFS + 1, true), Solver::GpuPcg);
    // an explicit choice is never overridden by the size
    assert_eq!(resolve_solver(Solver::GpuPcg, 1, false), Solver::GpuPcg);
    assert_eq!(resolve_solver(Solver::CpuDirect, usize::MAX, true), Solver::CpuDirect);
}

#[test]
fn the_cost_estimate_counts_small_patterns_and_their_mandatory_storage() {
    for kind in ALL_KINDS {
        let mesh = patch_mesh(kind);
        for dpn in [1, 2, 3] {
            let pat = pattern(&mesh, dpn);
            for solver in [Solver::Auto, Solver::CpuDirect, Solver::CpuPcg, Solver::GpuPcg] {
                let c = cost_estimate(&mesh, dpn, solver);
                assert_eq!(c.dofs, pat.csr.n as u64);
                assert_eq!(c.nnz, pat.csr.nnz() as u64);
                assert_eq!(c.nnz_lower, c.nnz);
                let csr_bytes = pat.csr.row_ptr.len() * 4 + pat.csr.col_idx.len() * 4 + pat.csr.vals.len() * 8;
                let expected = 2 * csr_bytes + 4 * (pat.slot.len() + pat.slot_ptr.len()) + 8 * pat.csr.n;
                assert_eq!(c.bytes, expected as u64);
                assert_eq!(c.feasible, None, "factor fill/workspace is unknown even for small meshes");
                assert!(c.note.contains(&c.nnz.to_string()));
            }
        }
        assert!(cost_estimate(&mesh, 3, Solver::Auto).note.starts_with("cpu-direct"));
    }
    // Adjacent cells deduplicate shared couplings; a node no element touches still owns the
    // diagonal `pattern` seeds for it, and nothing else.
    let mut mesh = Structured { kind: ElementKind::Hex8, n: [2, 2, 2] }.box_([1.0, 1.0, 1.0]);
    mesh.coords.extend([0.0; 3]);
    assert_eq!(cost_estimate(&mesh, 3, Solver::Auto).nnz, pattern(&mesh, 3).csr.nnz() as u64);
    let nodes = mesh.n_nodes() as u64;
    mesh.blocks.clear();
    assert_eq!(cost_estimate(&mesh, 3, Solver::Auto).nnz, nodes * 9);
}

#[test]
fn cost_counts_a_quarter_million_hexes_with_bounded_live_scratch() {
    // Independent tensor-grid graph oracle: each axis contributes 3*n+1 directed
    // neighbour pairs, including self pairs. Construct topology only, outside measurement.
    let [nx, ny, nz] = [50, 50, 100];
    let node = |x, y, z| (x + (nx + 1) * (y + (ny + 1) * z)) as u32;
    let mut conn = Vec::with_capacity(nx * ny * nz * 8);
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                conn.extend([
                    node(x, y, z),
                    node(x + 1, y, z),
                    node(x + 1, y + 1, z),
                    node(x, y + 1, z),
                    node(x, y, z + 1),
                    node(x + 1, y, z + 1),
                    node(x + 1, y + 1, z + 1),
                    node(x, y + 1, z + 1),
                ]);
            }
        }
    }
    let mesh = Mesh {
        dim: 3,
        coords: vec![0.0; (nx + 1) * (ny + 1) * (nz + 1) * 3],
        blocks: vec![ElementBlock { kind: ElementKind::Hex8, conn, first_elem: 0 }],
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::new(),
        face_sets: BTreeMap::new(),
    };
    let (c, peak) = cost_allocator::measure(|| cost_estimate(&mesh, 3, Solver::Auto));
    assert_eq!(c.nnz, ((3 * nx + 1) * (3 * ny + 1) * (3 * nz + 1) * 9) as u64);
    assert_eq!(c.nnz_lower, c.nnz);
    assert!(peak <= 16 * 1024 * 1024, "scratch high-water mark: {peak} bytes");
    assert!(c.bytes >= 250_000 * 24 * 24 * 4, "element slots alone occupy 576 MB");
    assert_eq!(c.feasible, Some(false));
    println!("250000 hex8: nnz={}, mandatory={} bytes, scratch peak={peak} bytes", c.nnz, c.bytes);
}

#[test]
fn cost_bounds_oversized_topology_without_allocating_adjacency() {
    // Two overlapping eight-node cliques on twelve nodes, repeated: actual node NNZ
    // is 64+64-16=112. Repetition grows slots/adjacency but never changes this graph.
    let mut conn = Vec::with_capacity(750_000 * 8);
    for _ in 0..375_000 {
        conn.extend(0..8);
        conn.extend(4..12);
    }
    let mut mesh = Mesh {
        dim: 3,
        coords: vec![0.0; 12 * 3],
        blocks: vec![ElementBlock { kind: ElementKind::Hex8, conn, first_elem: 0 }],
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::new(),
        face_sets: BTreeMap::new(),
    };
    let (c, peak) = cost_allocator::measure(|| cost_estimate(&mesh, 3, Solver::Auto));
    assert_eq!((c.nnz_lower, c.nnz), (64 * 9, 144 * 9));
    assert!(c.nnz_lower <= 112 * 9 && c.nnz >= 112 * 9);
    assert!(peak < 1024, "fallback allocated {peak} bytes");
    assert!(c.bytes >= 750_000 * 24 * 24 * 4);
    assert_eq!(c.feasible, Some(false));
    assert_eq!(c.budget_bytes, 1_610_612_736);
    assert!(c.note.contains("exceeds planning budget"));
    // A degenerate first clique must not overstate the lower bound. Also exercise empty
    // blocks without reading a nonexistent first element.
    mesh.blocks[0].conn[..8].fill(0);
    mesh.blocks.push(ElementBlock { kind: ElementKind::Tri3, conn: vec![], first_elem: 750_000 });
    assert_eq!(cost_estimate(&mesh, 3, Solver::Auto).nnz_lower, 9);
    let c = cost_estimate(&mesh, usize::MAX, Solver::Auto);
    assert_eq!(c.bytes, u64::MAX);
    assert_eq!(c.nnz, u64::MAX);
}

#[test]
fn field_data_slices_by_component_and_extremes_carry_their_location() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 2.0, 3.0]);
    let data: Vec<f64> = (0..mesh.n_nodes()).flat_map(|n| [n as f64, -(n as f64), 0.5]).collect();
    let f = FieldData::new(Per::Node, 3, data);
    assert_eq!(f.len(), mesh.n_nodes());
    assert!(!f.is_empty());
    assert_eq!(f.component(1), (0..8).map(|n| -(n as f64)).collect::<Vec<_>>());
    let ex = extremes(&f, &mesh);
    assert_eq!(ex.len(), 3);
    assert_eq!(ex[0].min, 0.0);
    assert_eq!(ex[0].min_at, mesh.node(0));
    assert_eq!(ex[0].max, 7.0);
    assert_eq!(ex[0].max_at, mesh.node(7));
    assert_eq!(ex[1].min, -7.0);
    assert_eq!(ex[1].max, 0.0);
    // a constant component reports the lowest index at both ends
    assert_eq!(ex[2].min_at, mesh.node(0));
    assert_eq!(ex[2].max_at, mesh.node(0));
    assert!(FieldData::new(Per::ElemGp, 6, Vec::new()).is_empty());
    let per = [Per::Node, Per::ElemGp, Per::ElemNode];
    assert_eq!(format!("{per:?}"), "[Node, ElemGp, ElemNode]");
    assert_ne!(Per::Node, Per::ElemNode);
}

// ---------------------------------------------------------------------- loads

/// A quarter annulus in the xy plane, `a ≤ r ≤ b`, meshed with `kind`.
fn quarter_annulus(kind: ElementKind, a: f64, b: f64) -> Mesh {
    annulus(kind, 3, 8, a, b, [0.0, std::f64::consts::FRAC_PI_2])
}

fn apply(p: &Problem<'_>) -> (Vec<f64>, LoadTotals) {
    let mut f = vec![0.0; p.n_dofs()];
    let totals = assemble_loads(p, &mut f).expect("the loads assemble");
    (f, totals)
}

/// A pressure on a curved face integrates to `p × projected area`, exactly: the sum of the
/// outward normals over any closed-or-open face chain telescopes to the chord between its ends.
#[test]
fn a_pressure_on_a_curved_face_totals_the_projected_area() {
    let a = 1.0;
    let mesh = quarter_annulus(ElementKind::Quad8, a, 2.0);
    let sets = sets_of(&mesh);
    let bodies = vec!["ring".to_string()];
    let press = 3e6;
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::PlaneStrain, Formulation::Full, Vec::new());
    p.loads = vec![Load::Pressure { faces: "inner".into(), p: press }];
    let (f, totals) = apply(&p);
    // the inner face's outward normal points at the axis, so the pressure pushes the ring out
    for c in 0..2 {
        assert!((totals.force[c] - press * a).abs() <= 1e-12 * press * a, "component {c}: {}", totals.force[c]);
    }
    assert_eq!(totals.force[2], 0.0);
    let summed: f64 = f.iter().step_by(2).sum();
    assert!((summed - totals.force[0]).abs() <= 1e-9, "the vector and the total agree");
    // the face measure the "total force" form divides by is the arc, not the chord sum
    let arc = face_set_area(&p, "inner").expect("the inner face set");
    let exact = a * std::f64::consts::FRAC_PI_2;
    assert!((arc - exact).abs() <= 1e-4 * exact, "quadratic arc length {arc} vs {exact}");
}

/// Gravity totals `ρ g V`, and a traction totals `t · A`, on a box where both are exact.
#[test]
fn gravity_totals_rho_g_v_and_a_traction_totals_t_times_area() {
    let size = [2.0, 0.5, 0.25];
    let mesh = Structured { kind: ElementKind::Hex8, n: [4, 2, 2] }.box_(size);
    let sets = sets_of(&mesh);
    let bodies = vec!["block".to_string()];
    let volume = size[0] * size[1] * size[2];
    let g = [0.0, 0.0, -9.81];
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    p.loads = vec![Load::Gravity { g }];
    let (_, totals) = apply(&p);
    let weight = DENSITY * volume * g[2];
    assert!((totals.force[2] - weight).abs() <= 1e-9 * weight.abs(), "{} vs {weight}", totals.force[2]);
    assert_eq!([totals.force[0], totals.force[1]], [0.0, 0.0]);

    let t = [1e5, -2e5, 3e5];
    let area = size[1] * size[2];
    p.loads = vec![Load::Traction { faces: "xmax".into(), t }];
    let (_, totals) = apply(&p);
    for (c, &tc) in t.iter().enumerate() {
        assert!((totals.force[c] - tc * area).abs() <= 1e-9 * (tc * area).abs(), "component {c}");
    }
    assert!((face_set_area(&p, "xmax").expect("xmax") - area).abs() <= 1e-12 * area);

    // a nodal force is per node of the Set
    p.loads = vec![Load::NodalForce { nodes: "xmax".into(), f: [7.0, 0.0, 0.0] }];
    let (_, totals) = apply(&p);
    assert_eq!(totals.force[0], 7.0 * sets["xmax"].nodes.len() as f64);
    assert_eq!(Load::Gravity { g }.set(), None);
    assert_eq!(Load::NodalForce { nodes: "xmax".into(), f: [0.0; 3] }.set(), Some("xmax"));
    assert_eq!(Load::Pressure { faces: "xmax".into(), p: 1.0 }.set(), Some("xmax"));
    assert_eq!(Load::Traction { faces: "xmax".into(), t }.set(), Some("xmax"));
}

/// A6: a body free to expand under a uniform temperature rise strains by `α ΔT` and carries no
/// stress, for a solid, a quadratic solid, a plane-stress sheet and an axisymmetric ring.
#[test]
fn free_thermal_expansion_is_alpha_delta_t_with_no_stress() {
    let dt = 100.0;
    let cases: [(ElementKind, Idealisation); 4] = [
        (ElementKind::Hex8, Idealisation::Solid3d),
        (ElementKind::Hex20, Idealisation::Solid3d),
        (ElementKind::Quad4, Idealisation::PlaneStress { thickness: 0.1 }),
        (ElementKind::Quad4, Idealisation::Axisymmetric),
    ];
    for (kind, id) in cases {
        let axi = matches!(id, Idealisation::Axisymmetric);
        let n = if kind.dim() == 3 { [4, 4, 4] } else { [4, 4, 1] };
        // the axisymmetric ring sits away from the axis; everything else is a unit block
        let mesh = Structured { kind, n }.build(|q| [if axi { 1.0 } else { 0.0 } + q[0], q[1], q[2]]);
        let sets = sets_of(&mesh);
        let bodies = vec!["block".to_string()];
        // symmetry planes only: the body expands freely away from them
        let mut constraints = vec![fix("sym_y", "ymin", [false, true, false], 0.0)];
        if !axi {
            constraints.push(fix("sym_x", "xmin", [true, false, false], 0.0));
        }
        if kind.dim() == 3 {
            constraints.push(fix("sym_z", "zmin", [false, false, true], 0.0));
        }
        let mut p = problem(&mesh, &sets, &bodies, id.clone(), Formulation::IncompatibleModes, constraints);
        p.temperature = Some((vec![dt; mesh.n_nodes()], 0.0));
        let res = run_static(&p, &mut nop).expect("free expansion solves");
        let u = &res.fields[&Field::Displacement];
        // u = α ΔT x: the symmetry planes sit at x = 0 and the ring's radius stretches from the
        // axis, which is also x = 0
        for node in 0..mesh.n_nodes() {
            let x = mesh.node(node as u32);
            let want = [EXPANSION * dt * x[0], EXPANSION * dt * x[1], EXPANSION * dt * x[2]];
            for (c, &wc) in want.iter().enumerate().take(mesh.dim) {
                let got = u.data[node * 3 + c];
                assert!(
                    (got - wc).abs() <= 1e-10 * EXPANSION * dt,
                    "{kind:?} {id:?} node {node} component {c}: {got} vs {wc}"
                );
            }
        }
        // and every Gauss point is stress free
        let el = element_for(kind);
        let (nn, n_gp) = (kind.n_nodes(), el.n_gp());
        let mut coords = vec![0.0; nn * 3];
        let bound = 1e-10 * YOUNG * EXPANSION * dt;
        for elem in 0..mesh.n_elems() as u32 {
            mesh.elem_coords(elem, &mut coords);
            let mut ue = Vec::with_capacity(nn * mesh.dim);
            for &node in mesh.elem_nodes(elem) {
                for c in 0..mesh.dim {
                    ue.push(u.data[node as usize * 3 + c]);
                }
            }
            let t = vec![dt; nn];
            let mut c = ctx(&coords, &p.materials[0], id.clone(), Formulation::IncompatibleModes);
            c.temperature = Some(&t);
            let (mut sig, mut eps) = (vec![0.0; n_gp * VOIGT], vec![0.0; n_gp * VOIGT]);
            el.recover(&c, &ue, &mut sig, &mut eps).expect("recover");
            for (i, s) in sig.iter().enumerate() {
                assert!(s.abs() <= bound, "{kind:?} {id:?} element {elem} stress {i} = {s}");
            }
            // plane stress does not carry ε₃₃: the law condenses it away, so the recovered
            // array leaves it zero. Every other normal component is the free expansion.
            let carried = if let Idealisation::PlaneStress { .. } = id { 2 } else { 3 };
            for (i, e) in eps.iter().enumerate() {
                let want = if i % VOIGT < carried { EXPANSION * dt } else { 0.0 };
                assert!((e - want).abs() <= 1e-10 * EXPANSION * dt, "{kind:?} {id:?} strain {i} = {e}");
            }
        }
        // the thermal load is what flows here: E α ΔT over the unit section
        reaction_balance(&res, [0.0; 3], YOUNG * EXPANSION * dt);
    }
}

/// A Load on a Set that matched nothing is a `set.empty`, like a Constraint on one.
#[test]
fn a_load_on_an_empty_set_is_reported_by_the_checks() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
    let mut sets = sets_of(&mesh);
    sets.insert(
        "void".to_string(),
        ResolvedSet { kind: SetKind::Face, faces: Vec::new(), nodes: Vec::new(), elems: Vec::new() },
    );
    let bodies = vec!["c".to_string()];
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    p.loads = vec![Load::Pressure { faces: "void".into(), p: 1.0 }];
    assert_eq!(checks::all(&p)[0].code, ErrorCode::SetEmpty);
    p.loads = vec![Load::Pressure { faces: "nowhere".into(), p: 1.0 }];
    let e = assemble_loads(&p, &mut vec![0.0; p.n_dofs()]).expect_err("no such set");
    assert_eq!(e.code, ErrorCode::SetEmpty);
    assert_eq!(face_set_area(&p, "nowhere").expect_err("no such set").code, ErrorCode::SetEmpty);
}

/// Every Load that integrates over the mesh needs a material to know the idealisation's scale
/// and its density; only a nodal force does not.
#[test]
fn a_load_over_a_body_without_a_material_says_so() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
    let sets = sets_of(&mesh);
    let bodies = vec!["block".to_string()];
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    p.material_of_block = vec![None];
    let each = [
        Load::Pressure { faces: "xmax".into(), p: 1.0 },
        Load::Traction { faces: "xmax".into(), t: [1.0, 0.0, 0.0] },
        Load::Gravity { g: [0.0, 0.0, -9.81] },
    ];
    for load in each {
        p.loads = vec![load.clone()];
        let e = assemble_loads(&p, &mut vec![0.0; p.n_dofs()]).expect_err("no material");
        assert_eq!(e.code, ErrorCode::ModelNoMaterial, "{load:?}");
    }
    assert_eq!(face_set_area(&p, "xmax").expect_err("no material").code, ErrorCode::ModelNoMaterial);
    // a nodal force needs no material, only its Set
    p.loads = vec![Load::NodalForce { nodes: "nowhere".into(), f: [1.0; 3] }];
    let e = assemble_loads(&p, &mut vec![0.0; p.n_dofs()]).expect_err("no such set");
    assert_eq!(e.code, ErrorCode::SetEmpty);
}

// ------------------------------------------------------------- post-processing

/// A5's bar, stretched by a prescribed end displacement, as a Result to post-process.
fn stretched_bar(kind: ElementKind) -> (Mesh, BTreeMap<String, ResolvedSet>, f64, f64) {
    let mesh = Structured { kind, n: [6, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let delta = 2e-4;
    (mesh, sets, delta, YOUNG * delta)
}

fn bar_constraints(kind: ElementKind, delta: f64) -> Vec<Constraint> {
    let mut c = vec![
        fix("root", "xmin", [true, false, false], 0.0),
        fix("sym_y", "ymin", [false, true, false], 0.0),
        fix("pull", "xmax", [true, false, false], delta),
    ];
    if kind.dim() == 3 {
        c.push(fix("sym_z", "zmin", [false, false, true], 0.0));
    }
    c
}

/// A5's stress half: the nodal stress is `F/A = E δ / L` everywhere, averaged and not.
#[test]
fn the_uniaxial_bar_recovers_f_over_a_at_every_node_averaged_and_not() {
    for kind in ALL_KINDS {
        let (mesh, sets, delta, sigma) = stretched_bar(kind);
        let bodies = vec!["bar".to_string()];
        let id = if kind.dim() == 3 { Idealisation::Solid3d } else { Idealisation::PlaneStress { thickness: 0.1 } };
        let p = problem(&mesh, &sets, &bodies, id, Formulation::IncompatibleModes, bar_constraints(kind, delta));
        let res = run_static(&p, &mut nop).expect("the bar solves");
        for field in [Field::Stress, Field::StressUnaveraged] {
            let f = &res.fields[&field];
            assert_eq!(f.comps, VOIGT);
            for i in 0..f.len() {
                let s = &f.data[i * VOIGT..(i + 1) * VOIGT];
                assert!((s[0] - sigma).abs() <= 1e-8 * sigma, "{kind:?} {field:?} entry {i}: {}", s[0]);
                for (c, v) in s.iter().enumerate().skip(1) {
                    assert!(v.abs() <= 1e-8 * sigma, "{kind:?} {field:?} entry {i} component {c}: {v}");
                }
            }
        }
        assert_eq!(res.fields[&Field::Stress].per, Per::Node);
        assert_eq!(res.fields[&Field::StressUnaveraged].per, Per::ElemNode);
        // uniaxial: von Mises is |σ| and the principal stresses are (σ, 0, 0)
        let vm = &res.fields[&Field::VonMises];
        assert_eq!(vm.comps, 1);
        assert!(vm.data.iter().all(|v| (v - sigma).abs() <= 1e-7 * sigma), "{kind:?}");
        let pr = &res.fields[&Field::Principal];
        assert_eq!(pr.comps, 3);
        for i in 0..pr.len() {
            let want = [sigma, 0.0, 0.0];
            for (c, w) in want.iter().enumerate() {
                assert!((pr.data[i * 3 + c] - w).abs() <= 1e-7 * sigma, "{kind:?} node {i} principal {c}");
            }
        }
        // the axial strain is δ/L
        let strain = &res.fields[&Field::Strain];
        assert!(strain.data.iter().step_by(VOIGT).all(|e| (e - delta).abs() <= 1e-8 * delta), "{kind:?}");
    }
}

/// Probing a field the solve made constant gives that constant, wherever it is asked — Gauss
/// points included — and a point off the mesh gives nothing.
#[test]
fn a_probe_finds_the_element_and_a_path_walks_the_bar() {
    let kind = ElementKind::Hex8;
    let (mesh, sets, delta, sigma) = stretched_bar(kind);
    let bodies = vec!["bar".to_string()];
    let p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::IncompatibleModes,
        bar_constraints(kind, delta),
    );
    let res = run_static(&p, &mut nop).expect("the bar solves");
    let stress = &res.fields[&Field::Stress];
    let el = element_for(kind);
    let mut coords = vec![0.0; kind.n_nodes() * 3];
    let mut shape = vec![0.0; kind.n_nodes()];
    for elem in 0..mesh.n_elems() as u32 {
        mesh.elem_coords(elem, &mut coords);
        for g in 0..el.n_gp() {
            el.shape_at(el.gp_xi(g), &mut shape);
            let mut x = [0.0; 3];
            for (a, &n) in shape.iter().enumerate() {
                for (k, xk) in x.iter_mut().enumerate() {
                    *xk += n * coords[3 * a + k];
                }
            }
            let (found, v) = probe(&mesh, stress, x).expect("a Gauss point is inside its element");
            assert_eq!(found, elem, "the lowest element containing the point");
            assert!((v[0] - sigma).abs() <= 1e-7 * sigma, "{v:?}");
        }
    }
    assert!(probe(&mesh, stress, [2.0, 0.0, 0.0]).is_none(), "off the end of the bar");

    // the displacement along the axis rises monotonically from 0 to δ
    let u = &res.fields[&Field::Displacement];
    let line = path(&mesh, u, [0.0, 0.05, 0.05], [1.0, 0.05, 0.05], 11);
    assert_eq!(line.len(), 11);
    let ux: Vec<f64> = line.iter().map(|(_, v)| v.as_ref().expect("inside the bar")[0]).collect();
    assert!(ux.windows(2).all(|w| w[1] > w[0]), "{ux:?}");
    assert!((ux[0]).abs() <= 1e-12 && (ux[10] - delta).abs() <= 1e-12 * delta);
    assert_eq!(line[0].0, 0.0);
    assert_eq!(line[10].0, 1.0);
    // a path that leaves the mesh reports the gaps
    let off = path(&mesh, u, [-1.0, 0.05, 0.05], [-0.5, 0.05, 0.05], 2);
    assert!(off.iter().all(|(_, v)| v.is_none()));
    // fewer than two points is still a segment
    assert_eq!(path(&mesh, u, [0.0, 0.05, 0.05], [1.0, 0.05, 0.05], 0).len(), 2);
}

/// Principal stresses against hand-computed 3×3 cases, including a diagonal one the Jacobi
/// sweep must leave alone.
#[test]
fn principal_stresses_match_hand_computed_three_by_three_cases() {
    // (Voigt stress, expected principal values descending)
    let cases: [([f64; VOIGT], [f64; 3]); 4] = [
        ([3.0, 2.0, 1.0, 0.0, 0.0, 0.0], [3.0, 2.0, 1.0]),
        // pure shear in xy: ±τ and 0
        ([0.0, 0.0, 0.0, 5.0, 0.0, 0.0], [5.0, 0.0, -5.0]),
        // hydrostatic
        ([-4.0, -4.0, -4.0, 0.0, 0.0, 0.0], [-4.0, -4.0, -4.0]),
        // uniaxial plus shear in xz: (σ/2) ± sqrt((σ/2)² + τ²)
        ([2.0, 0.0, 0.0, 0.0, 1.5, 0.0], [1.0 + (1.0 + 2.25f64).sqrt(), 0.0, 1.0 - (1.0 + 2.25f64).sqrt()]),
    ];
    for (s, want) in cases {
        let f = FieldData::new(Per::Node, VOIGT, s.to_vec());
        let got = principal(&f);
        assert_eq!(got.comps, 3);
        for (c, w) in want.iter().enumerate() {
            assert!((got.data[c] - w).abs() <= 1e-12 * w.abs().max(1.0), "{s:?} principal {c}: {}", got.data[c]);
        }
        // the invariants must survive: trace and von Mises
        let trace: f64 = got.data.iter().sum();
        assert!((trace - (s[0] + s[1] + s[2])).abs() <= 1e-12 * trace.abs().max(1.0));
        let vm = von_mises(&f).data[0];
        let by_principal = (0.5
            * ((got.data[0] - got.data[1]).powi(2)
                + (got.data[1] - got.data[2]).powi(2)
                + (got.data[2] - got.data[0]).powi(2)))
        .sqrt();
        assert!((vm - by_principal).abs() <= 1e-12 * vm.max(1.0));
    }
}

/// Averaging stops at a material boundary: two blocks of different stiffness under the same
/// strain keep their own stress at the nodes they share.
#[test]
fn averaging_never_crosses_a_material_boundary() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [2, 1, 1] }.box_([2.0, 1.0, 1.0]);
    let sets = sets_of(&mesh);
    let bodies = vec!["left".to_string()];
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    // one block, one material: the shared face is averaged
    let per_elem = FieldData::new(Per::ElemNode, 1, (0..16).map(|i| if i < 8 { 1.0 } else { 3.0 }).collect());
    let averaged = average_at_nodes(&p, &per_elem);
    assert_eq!(averaged.per, Per::Node);
    assert_eq!(averaged.len(), mesh.n_nodes());
    let shared: Vec<f64> =
        (0..mesh.n_nodes()).filter(|&n| mesh.node(n as u32)[0] == 1.0).map(|n| averaged.data[n]).collect();
    assert!(shared.iter().all(|v| (v - 2.0).abs() < 1e-12), "{shared:?}");

    // pretend the two elements came from different Bodies: the shared nodes keep element 0's
    let split = Mesh {
        blocks: vec![
            femlab_geometry::ElementBlock {
                kind: ElementKind::Hex8,
                conn: mesh.blocks[0].conn[..8].to_vec(),
                first_elem: 0,
            },
            femlab_geometry::ElementBlock {
                kind: ElementKind::Hex8,
                conn: mesh.blocks[0].conn[8..].to_vec(),
                first_elem: 1,
            },
        ],
        ..mesh.clone()
    };
    let two = vec!["left".to_string(), "right".to_string()];
    let mut q = problem(&split, &sets, &two, Idealisation::Solid3d, Formulation::Full, Vec::new());
    q.materials.push(steel());
    q.material_of_block = vec![Some(0), Some(1)];
    let averaged = average_at_nodes(&q, &per_elem);
    let shared: Vec<f64> =
        (0..split.n_nodes()).filter(|&n| split.node(n as u32)[0] == 1.0).map(|n| averaged.data[n]).collect();
    assert!(shared.iter().all(|v| (v - 1.0).abs() < 1e-12), "the first material wins: {shared:?}");
    p.materials.truncate(1);
}

#[test]
fn the_observed_rate_recovers_a_planted_slope_and_richardson_the_limit() {
    let h = [0.4, 0.2, 0.1, 0.05];
    for slope in [1.0, 2.0, 3.0] {
        let err: Vec<f64> = h.iter().map(|x| 0.37 * libm::pow(*x, slope)).collect();
        assert!((observed_rate(&h, &err) - slope).abs() <= 1e-12, "slope {slope}");
    }
    // fewer than two usable points, or a zero error, is not a rate
    assert!(observed_rate(&h[..1], &[1.0]).is_nan());
    assert!(observed_rate(&h, &[0.0; 4]).is_nan());

    // q(h) = q* + c h^2 converges at rate 2 to q*
    let (q_star, c) = (1.25, 0.8);
    let q: Vec<f64> = h.iter().map(|x| q_star + c * x * x).collect();
    let (limit, rate) = richardson(&h, &q);
    assert!((rate - 2.0).abs() <= 1e-9, "{rate}");
    assert!((limit - q_star).abs() <= 1e-9 * q_star, "{limit}");
    // the order of the meshes does not matter
    let (rl, rr) = ([h[3], h[0], h[2], h[1]], [q[3], q[0], q[2], q[1]]);
    let (l2, r2) = richardson(&rl, &rr);
    assert!((l2 - limit).abs() <= 1e-9 && (r2 - rate).abs() <= 1e-9);
    // too few meshes, or a sequence that is not converging, has nothing to extrapolate
    assert!(richardson(&h[..2], &q[..2]).0.is_nan());
    assert!(richardson(&h, &[1.0, 2.0, 1.0, 2.0]).1.is_nan());
    assert!(richardson(&[1.0, 1.0, 1.0], &[3.0, 2.0, 1.0]).0.is_nan());
}

/// A: exact manufactured power laws, independent of the extrapolation equation/solver.
#[test]
fn richardson_recovers_unequal_refinements_and_is_invariant_to_units() {
    let (limit, rate) = richardson(&[3.0, 2.0, 1.0], &[10.0, 5.0, 2.0]);
    assert!((limit - 1.0).abs() < 1e-12 && (rate - 2.0).abs() < 1e-12);
    for sizes in [[4.0, 2.0, 1.0], [7.0, 4.0, 1.0], [7.0, 2.0, 1.0]] {
        for p in [0.5, 1.0, 2.0, 3.0, 4.0] {
            for c in [-0.8, 0.8] {
                for length_unit in [1e-100, 1.0, 1e100] {
                    for quantity_unit in [1e-200, 1.0, 1e200] {
                        let h = sizes.map(|h| h * length_unit);
                        let q = sizes.map(|h| (1.25 + c * libm::pow(h, p)) * quantity_unit);
                        let (limit, rate) = richardson(&h, &q);
                        assert!((rate - p).abs() < 1e-9, "{h:?}, {q:?}: p={rate}, expected {p}");
                        assert!((limit / quantity_unit - 1.25).abs() < 1e-8, "{h:?}: limit={limit}");
                    }
                }
            }
        }
    }
    // The extra coarse value is outside the asymptotic range and must be ignored.
    let (limit, rate) = richardson(&[1.0, 100.0, 3.0, 2.0], &[2.0, -999.0, 10.0, 5.0]);
    assert!((limit - 1.0).abs() < 1e-12 && (rate - 2.0).abs() < 1e-12);
    // The mesh-size quotient overflows, although the power-law data and its rate do not.
    let h = [1e200, 1e-200, 1e-300];
    let q = h.map(|h| 1.25 + 0.8 * libm::pow(h, 0.001));
    let (limit, rate) = richardson(&h, &q);
    assert!((limit - 1.25).abs() < 1e-10 && (rate - 0.001).abs() < 1e-12);
}

#[test]
fn richardson_declines_undefined_or_nonconvergent_power_laws() {
    let cases: &[(&[f64], &[f64])] = &[
        (&[3.0, 2.0], &[10.0, 5.0]),
        (&[3.0, 2.0, 1.0], &[10.0, 5.0]),
        (&[4.0, 2.0, 1.0], &[1.25, 1.5, 2.0]), // q = 1 + 1/h diverges
        (&[4.0, 2.0, 1.0], &[3.0, 2.0, 1.0]),  // q = 1 + log2(h) has no finite limit
        (&[4.0, 2.0, 1.0], &[1.0, 1.0, 1.0]),
        (&[4.0, 2.0, 1.0], &[3.0, 1.0, 2.0]),
        (&[4.0, 2.0, 1.0], &[3.0, 2.0, 2.0]),
        (&[4.0, 2.0, 1.0], &[3.0, 3.0, 2.0]),
        (&[3.0, 2.0, 0.0], &[10.0, 5.0, 2.0]),
        (&[3.0, 2.0, -1.0], &[10.0, 5.0, 2.0]),
        (&[3.0, 2.0, 2.0], &[10.0, 5.0, 2.0]),
        (&[3.0, 3.0, 2.0], &[10.0, 5.0, 2.0]),
        (&[f64::INFINITY, 2.0, 1.0], &[10.0, 5.0, 2.0]),
        (&[f64::NAN, 2.0, 1.0], &[10.0, 5.0, 2.0]),
        (&[3.0, 2.0, 1.0], &[f64::NAN, 5.0, 2.0]),
        (&[3.0, 2.0, 1.0], &[10.0, f64::INFINITY, 2.0]),
        (&[3.0, 2.0, 1.0], &[f64::MAX, -f64::MAX, -f64::MAX / 2.0]),
        (&[3.0, 2.0, 1.0], &[f64::MAX, f64::MAX, -f64::MAX]),
        (&[4.0, 2.0, 1.0], &[2.001e307, 1e307, 0.0]), // the limit overflows
    ];
    for &(h, q) in cases {
        let (limit, rate) = richardson(h, q);
        assert!(limit.is_nan() && rate.is_nan(), "{h:?}, {q:?}: ({limit}, {rate})");
    }
}

/// A point can sit inside an element's bounding box and outside the element: on a tetrahedral
/// mesh most of them do, and the probe must walk past those.
#[test]
fn a_probe_walks_past_elements_whose_box_it_is_only_nearly_in() {
    let mesh = Structured { kind: ElementKind::Tet4, n: [2, 2, 2] }.box_([1.0, 1.0, 1.0]);
    let f = FieldData::new(Per::Node, 1, (0..mesh.n_nodes()).map(|n| mesh.node(n as u32)[0]).collect());
    // a linear field is reproduced exactly wherever the probe lands
    for at in [[0.1, 0.9, 0.4], [0.5, 0.5, 0.5], [0.87, 0.13, 0.21]] {
        let (elem, v) = probe(&mesh, &f, at).expect("inside the cube");
        assert!(elem < mesh.n_elems() as u32);
        assert!((v[0] - at[0]).abs() <= 1e-12, "{at:?} gave {v:?}");
    }
    assert!(probe(&mesh, &f, [1.5, 0.5, 0.5]).is_none());
}

/// Stress recovery calls the material law, so it reports a law given the wrong properties —
/// which is how a caller that skipped assembly finds out.
#[test]
fn recovering_stress_reports_a_material_it_cannot_call() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
    let sets = sets_of(&mesh);
    let bodies = vec!["c".to_string()];
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    p.materials[0].props = vec![YOUNG];
    let u = vec![0.0; p.n_dofs()];
    assert_eq!(stress_gp(&p, &u).map(|_| ()).expect_err("one prop, not two").code, ErrorCode::MaterialProps);
}

/// A8: the whole Step, not just the assembly, is bit-identical at one and many threads —
/// through faer's parallel factorisation as well (plan A §5.1, R2).
#[test]
fn a_step_result_is_bit_identical_at_one_and_many_threads() {
    let many = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).max(2);
    // A5: the uniaxial bar. B1 coarse: the cantilever under a tip traction, which is what
    // exercises the factorisation on a three-dimensional pattern.
    let cases: [(ElementKind, [usize; 3], Vec<Load>); 2] = [
        (ElementKind::Hex8, [10, 1, 1], Vec::new()),
        (ElementKind::Hex8, [8, 2, 2], vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -1e5] }]),
    ];
    for (kind, n, loads) in cases {
        let mesh = Structured { kind, n }.box_([1.0, 0.1, 0.1]);
        let sets = sets_of(&mesh);
        let bodies = vec!["bar".to_string()];
        let constraints = if loads.is_empty() {
            bar_constraints(kind, 2e-4)
        } else {
            vec![fix("root", "xmin", [true, true, true], 0.0)]
        };
        let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::IncompatibleModes, constraints);
        p.loads = loads;
        let step = static_step(SolveOptions::default());
        let run = |threads: usize| {
            let pool = Pool::new(threads);
            pollster::block_on(procedure::run(&p, &step, &pool, None, None, &mut nop)).expect("solves")
        };
        let (one, par) = (run(1), run(many));
        assert_eq!(one.fields.keys().collect::<Vec<_>>(), par.fields.keys().collect::<Vec<_>>());
        for (name, a) in &one.fields {
            let b = &par.fields[name];
            let differing = a.data.iter().zip(&b.data).filter(|(x, y)| x.to_bits() != y.to_bits()).count();
            assert_eq!(differing, 0, "{name:?}: {differing} of {} values differ at {many} threads", a.data.len());
        }
        for (k, v) in &one.scalars {
            assert_eq!(v.to_bits(), par.scalars[k].to_bits(), "scalar {k}");
        }
        assert_eq!(one.reactions, par.reactions);
    }
}

/// The post-modal arithmetic is a fixed-order reduction too, so a sweep and the modal Step it
/// continues are bit-identical at one and many threads, retained frames included.
#[test]
fn a_harmonic_sweep_is_bit_identical_at_one_and_many_threads() {
    let many = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).max(2);
    let mesh = Structured { kind: ElementKind::Hex8, n: [8, 2, 2] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let mut p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("root", "xmin", [true, true, true], 0.0)],
    );
    p.loads = vec![Load::Traction { faces: "xmax".to_string(), t: [0.0, 0.0, -1e5] }];
    let modal = Step::Modal { n_modes: 2, shift: None, solver: SolveOptions::default() };
    let sweep = harmonic_step(10.0, 400.0, 5, 0.02, 1);
    let swept = |threads: usize| {
        let pool = Pool::new(threads);
        let modes = pollster::block_on(procedure::run(&p, &modal, &pool, None, None, &mut nop)).expect("modes");
        pollster::block_on(procedure::run(&p, &sweep, &pool, None, Some(&modes), &mut nop)).expect("a sweep")
    };
    let (one, par) = (swept(1), swept(many));
    let (a, b) = (one.sweep.expect("a sweep"), par.sweep.expect("a sweep"));
    assert_eq!(a.frequencies, b.frequencies);
    for (x, y) in a.amplitude.iter().chain(&a.phase).zip(b.amplitude.iter().chain(&b.phase)) {
        let differing = x.data.iter().zip(&y.data).filter(|(u, v)| u.to_bits() != v.to_bits()).count();
        assert_eq!(differing, 0, "{differing} sweep values differ at {many} threads");
    }
    for (k, v) in &one.scalars {
        assert_eq!(v.to_bits(), par.scalars[k].to_bits(), "scalar {k}");
    }
}

// -------------------------------------------------- amplituded static Steps (Benchmark B8)

/// A static Step whose Loads and prescribed displacements ride an amplitude `g(t)`.
fn ramped_step(amplitude: procedure::Amplitude, dt: f64, t_end: f64, output_every: usize) -> Step {
    Step::Static { solver: SolveOptions::default(), dt, t_end, amplitude: Some(amplitude), output_every }
}

fn displacements(r: &StepResult) -> &[f64] {
    &r.fields[&Field::Displacement].data
}

fn biggest(v: &[f64]) -> f64 {
    v.iter().fold(0.0, |m: f64, x| m.max(x.abs()))
}

fn reaction_of(r: &StepResult, name: &str) -> [f64; 3] {
    r.reactions.iter().find(|(n, _)| n == name).expect("the Constraint reports a reaction").1
}

/// The clamped cantilever of Benchmark B8, with a uniform temperature riding along.
///
/// Linear static is **affine** in the amplitude, not proportional: the amplitude scales the
/// Loads and the prescribed displacements, never the temperature, because the thermal strain
/// the element subtracts in `recover` belongs to the temperature field and not to the load
/// history. So the frame at `g = 0` must be the pure thermal answer — displacement, stress and
/// reactions alike — and the frame at `g = 1` today's un-amplituded answer. A procedure that
/// "simplified" this back into `g · u` would fail the first of those.
#[test]
fn an_amplitude_is_affine_in_the_loads_and_never_scales_the_temperature() {
    let mesh = cantilever_mesh([4, 1, 1], ElementKind::Hex8);
    let sets = sets_of(&mesh);
    let bodies = vec!["beam".to_string()];
    let build = |loads: Vec<Load>| {
        let mut p = problem(
            &mesh,
            &sets,
            &bodies,
            Idealisation::Solid3d,
            Formulation::Full,
            vec![fix("root", "xmin", [true, true, true], 0.0)],
        );
        p.loads = loads;
        p.temperature = Some((vec![60.0; mesh.n_nodes()], 0.0));
        p
    };
    let tip = || vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -1e5] }];
    let full = run_step(&build(tip()), &static_step(SolveOptions::default())).expect("solves");
    let thermal = run_step(&build(Vec::new()), &static_step(SolveOptions::default())).expect("solves");
    assert!(full.history.is_none(), "a static Step without an amplitude retains nothing");

    // g rises to 1 at t = 1 s and returns to 0 at t = 2 s: a load–unload cycle.
    let table = procedure::Amplitude::Table { t: vec![0.0, 1.0, 2.0], value: vec![0.0, 1.0, 0.0] };
    let p = build(tip());
    let ramped = run_step(&p, &ramped_step(table, 0.5, 2.0, 1)).expect("solves");
    let h = ramped.history.as_ref().expect("an amplituded static Step retains its increments");
    assert_eq!(h.field, Field::Displacement);
    assert_eq!(h.times, vec![0.0, 0.5, 1.0, 1.5, 2.0]);
    assert_eq!(ramped.scalars["increments"], 4.0);
    assert_eq!(ramped.scalars["dt"], 0.5);

    let (thermal_u, full_u) = (displacements(&thermal), displacements(&full));
    let scale = biggest(full_u);
    // Unloaded, the frame is the thermal answer — and that answer is not zero, which is what
    // makes this an affine check rather than a proportional one.
    assert!(biggest(thermal_u) > 1e-6, "the temperature has to move the beam: {}", biggest(thermal_u));
    for (frame, g) in h.values.iter().zip([0.0, 0.5, 1.0, 0.5, 0.0]) {
        for (i, &v) in frame.iter().enumerate() {
            let want = thermal_u[i] + g * (full_u[i] - thermal_u[i]);
            assert!((v - want).abs() <= 1e-14 * scale, "frame at g = {g}, dof {i}: {v} vs {want}");
        }
    }
    // The Result's own fields are the last increment, g = 0: the pure thermal state, stress
    // included, because the amplitude never touched the thermal strain.
    for (name, f) in &ramped.fields {
        let want = &thermal.fields[name].data;
        let tol = 1e-9 * biggest(want).max(1e-30);
        for (i, (&got, &w)) in f.data.iter().zip(want).enumerate() {
            assert!((got - w).abs() <= tol, "{name:?}[{i}] unloaded: {got} vs {w}");
        }
    }
    let (r, want) = (reaction_of(&ramped, "root"), reaction_of(&thermal, "root"));
    for c in 0..3 {
        assert!((r[c] - want[c]).abs() <= 1e-9 * (1.0 + want[c].abs()), "reaction {c}: {} vs {}", r[c], want[c]);
    }
    let area = face_set_area(&p, "xmax").expect("the tip face has an area");
    let total = -1e5 * area;
    assert!((full.scalars["applied_total_z"] - total).abs() <= 1e-9 * total.abs(), "the unramped total stands");
    for axis in ["x", "y", "z"] {
        assert_eq!(ramped.scalars[&format!("applied_total_{axis}")], 0.0, "no load is applied at g = 0 ({axis})");
    }
}

/// Without a temperature the schedule is exactly `g(t) · u`, prescribed displacements included,
/// retained at the output stride: the initial state, every third increment, and the final one
/// whether or not it is a stride.
#[test]
fn a_sine_amplitude_reproduces_g_at_every_retained_frame_on_the_output_stride() {
    let mesh = cantilever_mesh([4, 1, 1], ElementKind::Hex8);
    let sets = sets_of(&mesh);
    let bodies = vec!["beam".to_string()];
    let pull = 2e-4;
    let mut p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("root", "xmin", [true, true, true], 0.0), fix("pull", "xmax", [true, false, false], pull)],
    );
    p.loads = vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -1e5] }];
    let full = run_step(&p, &static_step(SolveOptions::default())).expect("solves");
    let sine = procedure::Amplitude::Sine { amplitude: 1.0, period: 4.0 };
    let ramped = run_step(&p, &ramped_step(sine.clone(), 0.125, 0.875, 3)).expect("solves");
    let h = ramped.history.as_ref().expect("retained");
    // Seven increments at an output stride of three: 0, 3, 6 and the endpoint 7.
    assert_eq!(ramped.scalars["increments"], 7.0);
    assert_eq!(ramped.scalars["dt"], 0.125);
    assert_eq!(h.times, vec![0.0, 0.375, 0.75, 0.875]);
    let full_u = displacements(&full);
    for (frame, &time) in h.values.iter().zip(&h.times) {
        let g = sine.at(time);
        for (i, &v) in frame.iter().enumerate() {
            assert_eq!(v, g * full_u[i], "frame at t = {time} (g = {g}), dof {i}");
        }
        // The prescribed displacement rides the same amplitude the Loads do.
        for &node in &sets["xmax"].nodes {
            assert_eq!(frame[node as usize * 3], g * pull, "the prescribed ux at t = {time}");
        }
    }
    // The Result's final field is the last increment, and the applied total rides with it.
    let g_end = sine.at(0.875);
    assert!(g_end > 0.9, "the endpoint is not a trivial multiple: {g_end}");
    assert_eq!(displacements(&ramped), &h.values[3][..]);
    assert_eq!(ramped.scalars["applied_total_z"], full.scalars["applied_total_z"] * g_end);
    for name in ["root", "pull"] {
        let (r, want) = (reaction_of(&ramped, name), reaction_of(&full, name));
        for c in 0..3 {
            let tol = 1e-9 * (1.0 + want[c].abs());
            assert!((r[c] - g_end * want[c]).abs() <= tol, "reaction {name} {c}: {} vs {}", r[c], want[c]);
        }
    }
}

/// A8 for an amplituded Step: every retained frame is bit-identical at one and many threads,
/// including the second solve the affine split runs for the thermal part.
#[test]
fn an_amplituded_step_retains_bit_identical_frames_at_one_and_many_threads() {
    let many = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).max(2);
    let mesh = cantilever_mesh([8, 2, 2], ElementKind::Hex8);
    let sets = sets_of(&mesh);
    let bodies = vec!["beam".to_string()];
    let mut p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::IncompatibleModes,
        vec![fix("root", "xmin", [true, true, true], 0.0)],
    );
    p.loads = vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -1e5] }];
    p.temperature = Some((vec![40.0; mesh.n_nodes()], 0.0));
    let step = ramped_step(procedure::Amplitude::Sine { amplitude: 1.0, period: 4.0 }, 0.25, 1.0, 1);
    let run = |threads: usize| {
        let pool = Pool::new(threads);
        pollster::block_on(procedure::run(&p, &step, &pool, None, None, &mut nop)).expect("solves")
    };
    let (one, par) = (run(1), run(many));
    let (a, b) = (one.history.expect("retained"), par.history.expect("retained"));
    assert_eq!(a.times, b.times);
    assert_eq!(a.values.len(), 5);
    let differing = a.values.concat().iter().zip(b.values.concat()).filter(|(x, y)| x.to_bits() != y.to_bits()).count();
    assert_eq!(differing, 0, "{differing} retained values differ at {many} threads");
    for (k, v) in &one.scalars {
        assert_eq!(v.to_bits(), par.scalars[k].to_bits(), "scalar {k}");
    }
}

/// The endpoint is a real clock: a schedule that cannot be represented is a schema error
/// naming the field, not a silent one-increment Step.
#[test]
fn an_amplituded_static_step_needs_a_representable_time_grid() {
    let mesh = cantilever_mesh([1, 1, 1], ElementKind::Hex8);
    let sets = sets_of(&mesh);
    let bodies = vec!["beam".to_string()];
    let p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("root", "xmin", [true, true, true], 0.0)],
    );
    let sine = procedure::Amplitude::Sine { amplitude: 1.0, period: 4.0 };
    let step = ramped_step(sine, 1.0, -1.0, 1);
    let e = pollster::block_on(procedure::run(&p, &step, &Pool::new(2), None, None, &mut nop))
        .expect_err("a negative endpoint is not a Step");
    assert_eq!(e.code, ErrorCode::Schema);
    assert_eq!(e.where_.as_deref(), Some("dt"));
}

/// A host that says stop during the second (thermal) solve of an amplituded Step is obeyed:
/// the affine split runs two solves, and both are cancellable.
#[test]
fn a_host_that_says_stop_cancels_the_thermal_solve_of_an_amplituded_step() {
    let mesh = cantilever_mesh([2, 1, 1], ElementKind::Hex8);
    let sets = sets_of(&mesh);
    let bodies = vec!["beam".to_string()];
    let mut p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("root", "xmin", [true, true, true], 0.0)],
    );
    p.temperature = Some((vec![60.0; mesh.n_nodes()], 0.0));
    let sine = procedure::Amplitude::Sine { amplitude: 1.0, period: 4.0 };
    let step = ramped_step(sine, 1.0, 1.0, 1);
    // Phase 0 is the assembly report, 1 the load solve, 2 the thermal solve, 3 the recovery.
    for at in 0..4 {
        let mut stop = cancel_on(at);
        let e =
            pollster::block_on(procedure::run(&p, &step, &Pool::new(2), None, None, &mut stop)).expect_err("cancelled");
        assert_eq!(e.code, ErrorCode::Cancelled, "phase {at}");
    }
}

// ------------------------------------------------------- heat, modal, transient, explicit
//
// Benchmarks E1, E2, C7, E3, B4, C6, F1 and F2 of `docs/BENCHMARKS.md`, plus the
// well-posedness and argument checks the four new procedures own. Everything here builds a
// `Problem` and calls `procedure::run` directly; the Command-level forms are the Journals in
// `crates/femlab/benches/cases`.

/// A Material with a conductivity, a capacity and a density, for the heat and dynamics cases.
fn conductor(k: f64, rho: f64, cp: f64) -> Material {
    Material {
        law: builtin_law("linear-elastic").expect("built in"),
        props: vec![YOUNG, POISSON],
        rho,
        alpha: 0.0,
        k,
        cp,
    }
}

/// A heat Problem over one Body with the given held temperatures and boundary loads.
fn heat_problem<'a>(
    mesh: &'a Mesh,
    sets: &'a BTreeMap<String, ResolvedSet>,
    bodies: &'a [String],
    id: Idealisation,
    material: Material,
    constraints: Vec<Constraint>,
    heat_loads: Vec<HeatLoad>,
) -> Problem<'a> {
    Problem {
        mesh,
        sets,
        body_of_block: bodies,
        material_of_block: vec![Some(0); mesh.blocks.len()],
        materials: vec![material],
        section_of_block: vec![None; mesh.blocks.len()],
        sections: Vec::new(),
        idealisation: id,
        formulation: Formulation::Full,
        constraints,
        couplings: Vec::new(),
        points: Vec::new(),
        loads: Vec::new(),
        temperature: None,
        heat: true,
        heat_loads,
    }
}

/// A held temperature on a Set: the heat DOF is component 0.
fn hold(name: &str, on: &str, value: f64) -> Constraint {
    Constraint { name: name.into(), nodes: on.into(), dofs: [true, false, false], value }
}

fn run_step(p: &Problem<'_>, step: &Step) -> Result<StepResult, Error> {
    pollster::block_on(procedure::run(p, step, &Pool::new(2), None, None, &mut nop))
}

/// A Step run against the Result of the Step it continues, which is what `after` gives it.
fn run_after(p: &Problem<'_>, step: &Step, previous: Option<&StepResult>) -> Result<StepResult, Error> {
    pollster::block_on(procedure::run(p, step, &Pool::new(2), None, previous, &mut nop))
}

/// A linearly spaced harmonic sweep at one constant modal damping ratio.
fn harmonic_step(f_start: f64, f_stop: f64, points: usize, zeta: f64, output_every: usize) -> Step {
    Step::Harmonic {
        f_start,
        f_stop,
        points,
        spacing: SweepSpacing::Linear,
        damping_ratio: Some(zeta),
        rayleigh: (0.0, 0.0),
        output_every,
    }
}

fn steady() -> Step {
    Step::HeatSteady { solver: SolveOptions::default(), control: NonlinearControl::default() }
}

/// The nodal temperature of a heat Result.
fn temperature_of(res: &StepResult) -> Vec<f64> {
    res.fields[&Field::Temperature].component(0)
}

/// The temperature interpolated at a point.
fn temperature_at(mesh: &Mesh, res: &StepResult, x: [f64; 3]) -> f64 {
    probe(mesh, &res.fields[&Field::Temperature], x).expect("the point is inside the mesh").1[0]
}

/// One `Body` name, as the Problem wants it.
fn one_body() -> Vec<String> {
    vec!["bar".to_string()]
}

/// Benchmark E1: a bar between two fixed temperatures conducts a linear profile, exactly, for
/// every element family — hexahedra, tetrahedra from the Kuhn split, quadrilaterals, triangles.
#[test]
fn a_bar_between_two_fixed_temperatures_is_linear_for_every_kind() {
    let (t0, t1, length) = (300.0, 400.0, 1.0);
    for kind in [ElementKind::Hex8, ElementKind::Tet4, ElementKind::Quad4, ElementKind::Tri3] {
        let mesh = Structured { kind, n: [10, 1, 1] }.box_([length, 0.1, 0.1]);
        let id = if kind.dim() == 3 { Idealisation::Solid3d } else { Idealisation::PlaneStrain };
        let sets = sets_of(&mesh);
        let bodies = one_body();
        let p = heat_problem(
            &mesh,
            &sets,
            &bodies,
            id,
            conductor(45.0, 7800.0, 460.0),
            vec![hold("cold", "xmin", t0), hold("hot", "xmax", t1)],
            Vec::new(),
        );
        let res = run_step(&p, &steady()).expect("a well-posed conduction problem");
        for (node, got) in temperature_of(&res).iter().enumerate() {
            let want = t0 + (t1 - t0) * mesh.node(node as u32)[0] / length;
            assert!((got - want).abs() <= 1e-10 * (t1 - t0), "{kind:?} node {node}: {got} vs {want}");
        }
        // The heat that enters at the hot end leaves at the cold one, and the balance says so.
        let (cold, hot) = (res.reactions[0].1[0], res.reactions[1].1[0]);
        assert!((cold + hot).abs() <= 1e-9 * hot.abs(), "{kind:?}: {cold} + {hot}");
    }
}

/// E: net heat entering equals heat removed, for every built-in element family.
#[test]
fn steady_heat_power_balances_flux_sources_and_outgoing_convection() {
    for kind in ALL_KINDS {
        for n in [2, 4] {
            let (mesh, id, area) = if kind.dim() == 3 {
                (Structured { kind, n: [n, 1, 1] }.box_([1.0, 0.1, 0.1]), Idealisation::Solid3d, 0.01)
            } else {
                (
                    Structured { kind, n: [n, 1, 1] }.box_([1.0, 0.1, 0.0]),
                    Idealisation::PlaneStress { thickness: 0.2 },
                    0.02,
                )
            };
            let sets = sets_of(&mesh);
            let bodies = one_body();
            let p = heat_problem(
                &mesh,
                &sets,
                &bodies,
                id.clone(),
                conductor(45.0, 1.0, 1.0),
                vec![hold("cold", "xmax", 293.15)],
                vec![
                    HeatLoad::Flux { faces: "xmin".into(), q: 1000.0 },
                    HeatLoad::Source { bodies: bodies.clone(), q: 500.0 },
                ],
            );
            let res = run_step(&p, &steady()).unwrap();
            let expected = area * (1000.0 + 500.0 * 1.0); // q_surface*A + q_volume*V
            assert!((res.scalars["applied_total_x"] - expected).abs() < 1e-8, "{kind:?}");
            assert!((res.reactions[0].1[0] - expected).abs() < 1e-8, "{kind:?}");
            assert_eq!(res.scalars["storage_power"], 0.0);
            // With no temperature support, the film must remove all prescribed input.
            for flux in [0.0, 1000.0] {
                let p = heat_problem(
                    &mesh,
                    &sets,
                    &bodies,
                    id.clone(),
                    conductor(45.0, 1.0, 1.0),
                    Vec::new(),
                    vec![
                        HeatLoad::Flux { faces: "xmin".into(), q: flux },
                        HeatLoad::Convection { faces: "xmax".into(), h: 25.0, t_inf: 283.15 },
                        HeatLoad::Convection { faces: "xmax".into(), h: 25.0, t_inf: 303.15 },
                    ],
                );
                let res = run_step(&p, &steady()).unwrap();
                assert!(res.scalars["applied_total_x"].abs() < 1e-8, "{kind:?}: {:?}", res.scalars);
                assert!(res.reactions.is_empty());
                // The film face temperature follows q/h independently of k or mesh spacing.
                for &node in &sets["xmax"].nodes {
                    assert!((temperature_of(&res)[node as usize] - (293.15 + flux / 50.0)).abs() < 1e-8);
                }
            }
        }
    }
}

/// E: prescribed T(x,t)=(10+4x)(1+t) has exact energy rate ρcp V*12. The last
/// θ-stage gradient is 4*(1+t_old+θdt), which distinguishes stage powers from endpoint powers.
#[test]
fn transient_heat_reactions_include_storage_at_the_last_theta_stage() {
    for n in [2, 4] {
        for theta in [0.5, 0.75, 1.0] {
            for (requested_dt, end, effective_dt) in [(1.0, 2.0, 1.0), (0.4, 0.9, 0.3)] {
                let mesh = Structured { kind: ElementKind::Hex8, n: [n, 1, 1] }.box_([1.0, 0.1, 0.1]);
                let mut sets = sets_of(&mesh);
                let bodies = one_body();
                let mut constraints = Vec::new();
                for node in 0..mesh.n_nodes() as u32 {
                    let name = format!("node{node}");
                    sets.insert(
                        name.clone(),
                        ResolvedSet { kind: SetKind::Node, nodes: vec![node], faces: Vec::new(), elems: Vec::new() },
                    );
                    constraints.push(hold(&name, &name, 10.0 + 4.0 * mesh.node(node)[0]));
                }
                for (loads, film) in [
                    (Vec::new(), 0.0),
                    (vec![HeatLoad::Convection { faces: "xmax".into(), h: 50.0, t_inf: 100.0 }], 50.0),
                ] {
                    let p = heat_problem(
                        &mesh,
                        &sets,
                        &bodies,
                        Idealisation::Solid3d,
                        conductor(45.0, 1.0, 1.0),
                        constraints.clone(),
                        loads,
                    );
                    // Keep only endpoints: power uses the final internal interval, including
                    // the independently known 0.3 s increment for a 0.4/0.9 s request.
                    let step = Step::HeatTransient {
                        dt: requested_dt,
                        t_end: end,
                        theta,
                        initial: 10.0,
                        output_every: 99,
                        amplitude: Some(procedure::Amplitude::Table { t: vec![0.0, 2.0], value: vec![1.0, 3.0] }),
                        solver: SolveOptions::default(),
                        control: NonlinearControl::default(),
                    };
                    let res = run_step(&p, &step).unwrap();
                    assert!((res.scalars["storage_power"] - 0.12).abs() < 1e-10);
                    assert!((res.scalars["dt"] - effective_dt).abs() < 1e-15);
                    let stage_factor = 1.0 + end - (1.0 - theta) * effective_dt;
                    let applied = film * 0.01 * (100.0 - 14.0 * stage_factor);
                    assert!((res.scalars["applied_total_x"] - applied).abs() < 1e-10);
                    let removed: f64 = res.reactions.iter().map(|(_, r)| r[0]).sum();
                    assert!((removed - applied + 0.12).abs() < 1e-10); // prescribed heating adds, rather than removes, power
                    let cold: f64 = sets["xmin"]
                        .nodes
                        .iter()
                        .map(|&node| res.fields[&Field::Reaction].data[node as usize * 3])
                        .sum();
                    let dx = 1.0 / n as f64;
                    // Exact integral of the left-end linear basis times dT/dt over its adjacent cell.
                    let storage_at_cold = 0.01 * dx * (30.0 + 4.0 * dx) / 6.0;
                    let expected_cold = 45.0 * 0.01 * 4.0 * stage_factor - storage_at_cold;
                    assert!((cold - expected_cold).abs() < 1e-10, "n={n}, θ={theta}: {cold} vs {expected_cold}");
                    assert_eq!(res.history.as_ref().unwrap().times, [0.0, end]);
                    for (node, t) in temperature_of(&res).iter().enumerate() {
                        assert!((t - (1.0 + end) * (10.0 + 4.0 * mesh.node(node as u32)[0])).abs() < 1e-12);
                    }
                }
            }
        }
    }
}

/// Benchmark E2 (Ansys VM97): a fin with convection along both faces and over its tip, against
/// the closed-form fin with a convective tip.
///
/// The published fin formula is one-dimensional; the model here is the real two-dimensional
/// slab, whose mid-plane has to conduct across the half-thickness before the film can take the
/// heat away. That resistance keeps the fin hotter than the 1D formula, by an amount set by the
/// Biot number `h·(t/2)/k` — 0.042 for VM97's proportions. The case therefore asserts three
/// things: the tip is within 2 % of the 1D formula at VM97's thickness, the two meshes agree to
/// 0.1 % so the remainder is physics rather than discretisation, and a fin of the same `mL` with
/// a tenth of the Biot number — where the 1D formula really is the answer — lands inside 0.3 %.
#[test]
fn ansys_vm97_fin_matches_the_closed_form_with_a_convective_tip() {
    let (length, thick) = (0.1016f64, 0.0254f64);
    let coarse = fin_tip_error(length, thick, [16, 4]);
    let fine = fin_tip_error(length, thick, [32, 8]);
    assert!(fine <= 0.02, "tip rise off the 1D fin by {:.3} %", 100.0 * fine);
    assert!((fine - coarse).abs() <= 1e-3, "the two meshes disagree: {coarse} and {fine}");
    // Ten times thinner and √10 times shorter, so `mL` — and therefore the shape of the 1D
    // answer — is unchanged and only the Biot number falls, by ten.
    let thin = fin_tip_error(length / 10.0f64.sqrt(), 0.1 * thick, [32, 8]);
    assert!(thin <= 0.003, "a thin fin should match the 1D formula: {:.3} %", 100.0 * thin);
    assert!(thin * 4.0 < fine, "the gap should fall with the Biot number: {thin} against {fine}");
}

/// The relative error of the tip temperature rise of a plane fin against the 1D closed form
/// with a convective tip: `θ(L)/θ₀ = 1 / [cosh mL + (h/mk) sinh mL]`, `m = √(2h/(k t))`.
fn fin_tip_error(length: f64, thick: f64, n: [usize; 2]) -> f64 {
    let (k, h, t_wall, t_inf) = (25.96f64, 85.17f64, 866.48f64, 310.93f64);
    let m = (h * 2.0 / (k * thick)).sqrt();
    let ratio = h / (m * k);
    let want = (t_wall - t_inf) / (libm::cosh(m * length) + ratio * libm::sinh(m * length));
    let mesh = Structured { kind: ElementKind::Quad8, n: [n[0], n[1], 1] }.box_([length, thick, 0.0]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let film = |set: &str| HeatLoad::Convection { faces: set.into(), h, t_inf };
    let p = heat_problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::PlaneStrain,
        conductor(k, 7800.0, 460.0),
        vec![hold("root", "xmin", t_wall)],
        vec![film("xmax"), film("ymin"), film("ymax")],
    );
    let res = run_step(&p, &steady()).expect("a well-posed fin");
    let tip = temperature_at(&mesh, &res, [length, 0.5 * thick, 0.0]) - t_inf;
    (tip - want).abs() / want
}

/// Benchmark C7 (NAFEMS T4): steady conduction in a rectangle with one held edge, one
/// insulated edge and two convecting edges. T(E) = 18.3 °C at E = (0.6, 0.2).
#[test]
fn nafems_t4_conduction_with_convection_reaches_eighteen_point_three_degrees() {
    let (w, hgt) = (0.6, 1.0);
    let (k, film, t_inf, t_hot) = (52.0, 750.0, 273.15, 373.15);
    let want = 273.15 + 18.3;
    let mut errors = Vec::new();
    for n in [[6, 10], [12, 20], [24, 40]] {
        let mesh = Structured { kind: ElementKind::Quad8, n: [n[0], n[1], 1] }.box_([w, hgt, 0.0]);
        let sets = sets_of(&mesh);
        let bodies = one_body();
        let conv = |set: &str| HeatLoad::Convection { faces: set.into(), h: film, t_inf };
        let p = heat_problem(
            &mesh,
            &sets,
            &bodies,
            Idealisation::PlaneStrain,
            conductor(k, 7800.0, 460.0),
            vec![hold("ab", "ymin", t_hot)],
            // DA (x = 0) is insulated, which needs no boundary condition at all.
            vec![conv("xmax"), conv("ymax")],
        );
        let res = run_step(&p, &steady()).expect("a well-posed T4");
        errors.push(temperature_at(&mesh, &res, [w, 0.2, 0.0]));
    }
    assert!((errors[1] - want).abs() <= 0.5 && (errors[2] - want).abs() <= 0.5, "T(E) = {errors:?}, want {want}");
    // The published 18.3 is the rounded value of a converged 18.25, so the honest convergence
    // statement is that the successive changes shrink, not that the gap to 18.3 does.
    assert!(
        (errors[2] - errors[1]).abs() < (errors[1] - errors[0]).abs(),
        "the mesh sequence is not settling: {errors:?}"
    );
}

/// A steady heat Step over a mesh whose faces convect and nothing is held is still well posed:
/// the film is what makes `K + H` non-singular. Without either, the check names the fix.
#[test]
fn a_heat_step_needs_a_held_temperature_or_a_convection_boundary() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [2, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let bare = heat_problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        conductor(45.0, 7800.0, 460.0),
        Vec::new(),
        vec![HeatLoad::Flux { faces: "xmin".into(), q: 100.0 }],
    );
    let e = run_step(&bare, &steady()).expect_err("nothing holds the temperature");
    assert_eq!(e.code, ErrorCode::ConstraintRigidModes);
    assert!(e.cause.contains("not held anywhere"), "{}", e.cause);

    // The same body with a film on the far face: a flux in, a film out, and a solvable balance.
    let convected = heat_problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        conductor(45.0, 7800.0, 460.0),
        Vec::new(),
        vec![
            HeatLoad::Flux { faces: "xmin".into(), q: 1000.0 },
            HeatLoad::Convection { faces: "xmax".into(), h: 50.0, t_inf: 300.0 },
        ],
    );
    let res = run_step(&convected, &steady()).expect("the film holds it");
    let t = temperature_of(&res);
    // Steady state: everything that enters at xmin leaves through the film, so the far face
    // sits at T∞ + q A /(h A) and the near face one conduction drop above it.
    let area = 0.01;
    let far = 300.0 + 1000.0 * area / (50.0 * area);
    let near = far + 1000.0 * 1.0 / 45.0;
    let (lo, hi) = (t.iter().copied().fold(f64::INFINITY, f64::min), t.iter().copied().fold(0.0f64, f64::max));
    assert!((lo - far).abs() <= 1e-9 * far, "far face {lo} vs {far}");
    assert!((hi - near).abs() <= 1e-9 * near, "near face {hi} vs {near}");
    assert_eq!(HeatLoad::Source { bodies: one_body(), q: 1.0 }.set(), None);
    assert_eq!(HeatLoad::Flux { faces: "f".into(), q: 1.0 }.set(), Some("f"));
    assert_eq!(HeatLoad::Convection { faces: "c".into(), h: 1.0, t_inf: 0.0 }.set(), Some("c"));
}

/// A volumetric source in a slab held at both faces gives the parabolic profile
/// `T = T_s + q (L x − x²) / 2k`, which is the oracle for `load.heatSource`.
#[test]
fn a_volumetric_source_in_a_held_slab_is_parabolic() {
    let (length, k, q, t_s) = (0.2, 45.0, 5e5, 300.0);
    let mesh = Structured { kind: ElementKind::Hex20, n: [8, 1, 1] }.box_([length, 0.05, 0.05]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = heat_problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        conductor(k, 7800.0, 460.0),
        vec![hold("left", "xmin", t_s), hold("right", "xmax", t_s)],
        vec![HeatLoad::Source { bodies: one_body(), q }],
    );
    let res = run_step(&p, &steady()).expect("a well-posed slab");
    for (node, got) in temperature_of(&res).iter().enumerate() {
        let x = mesh.node(node as u32)[0];
        let want = t_s + q * (length * x - x * x) / (2.0 * k);
        assert!((got - want).abs() <= 1e-8 * (want - t_s).max(1.0), "node {node}: {got} vs {want}");
    }
}

/// Benchmark E3 (NAFEMS T3): a bar driven by `100 sin(π t / 40)` at one end and held at zero at
/// the other reaches 36.60 K at x = 0.08 m after 32 s. Crank–Nicolson at Δt = 0.5 s.
///
/// The Step runs in kelvin above the initial state, which is the same problem the published
/// case states in °C: linear conduction is invariant under a shift of the whole temperature.
#[test]
fn nafems_t3_transient_reaches_thirty_six_point_six_at_thirty_two_seconds() {
    let (t_at, dt, rows) = t3_probe(0.5, 0.5, 32.0);
    assert!((t_at - 36.60).abs() <= 0.5, "T at 20 mm from the driven end after 32 s = {t_at}");
    assert!((dt - 0.5).abs() < 1e-12);
    // A history row per step, from t = 0 to t = 32 s.
    assert_eq!(rows, 65);
}

/// The θ-method's temporal order: Crank–Nicolson is second order, backward Euler first, both
/// measured against the same problem at a quarter of the smallest step.
#[test]
fn the_theta_method_converges_at_its_own_order_in_time() {
    for (theta, expected) in [(0.5, 1.8), (1.0, 0.8)] {
        let reference = t3_probe(theta, 0.0625, 32.0).0;
        let steps = [1.0, 0.5, 0.25];
        let errors: Vec<f64> = steps.iter().map(|&dt| (t3_probe(theta, dt, 32.0).0 - reference).abs()).collect();
        let rate = observed_rate(&steps, &errors);
        assert!(rate >= expected, "θ = {theta}: rate {rate} below {expected} ({errors:?})");
        assert!(errors[1] < errors[0] && errors[2] < errors[1], "θ = {theta}: {errors:?}");
    }
}

/// E3 endpoint regression: uniform heating at q/(rho cp) = 1 K/s gives T(x,t) = t exactly.
/// The held face follows the same ramp, so the free-node solution is independent of mesh
/// spacing and theta. A final timestamp alone cannot hide an over/under-integrated field.
#[test]
fn transient_heat_reaches_the_requested_endpoint_with_the_correct_temperature() {
    for nx in [2, 4] {
        let mesh = Structured { kind: ElementKind::Hex8, n: [nx, 1, 1] }.box_([1.0, 0.1, 0.1]);
        let sets = sets_of(&mesh);
        let bodies = one_body();
        let p = heat_problem(
            &mesh,
            &sets,
            &bodies,
            Idealisation::Solid3d,
            conductor(1.0, 2.0, 3.0),
            vec![hold("left", "xmin", 1.0)],
            vec![HeatLoad::Source { bodies: one_body(), q: 6.0 }],
        );
        for (dt, t_end) in [(0.6, 1.0), (0.4, 0.9), (2.0, 0.25)] {
            for theta in [0.5, 1.0] {
                let step = Step::HeatTransient {
                    dt,
                    t_end,
                    theta,
                    initial: 0.0,
                    output_every: 2,
                    amplitude: Some(procedure::Amplitude::Table { t: vec![0.0, t_end], value: vec![0.0, t_end] }),
                    solver: SolveOptions::default(),
                    control: NonlinearControl::default(),
                };
                let res = run_step(&p, &step).expect("a uniformly heated transient");
                assert!(res.scalars["dt"] <= dt);
                let h = res.history.as_ref().unwrap();
                assert_eq!(*h.times.last().unwrap(), t_end);
                for (&time, temperatures) in h.times.iter().zip(&h.values) {
                    for temperature in temperatures {
                        assert!(
                            (temperature - time).abs() < 1e-10,
                            "nx={nx}, dt={dt}, theta={theta}: T={temperature} at t={time}"
                        );
                    }
                }
                for temperature in temperature_of(&res) {
                    assert!((temperature - t_end).abs() < 1e-10);
                }
            }
        }
    }
}

/// F2b endpoint regression: rigid free fall has u(t) = v0 t + g t²/2, exactly for leapfrog.
#[test]
fn explicit_free_fall_reaches_the_requested_endpoint_without_exceeding_its_step_bound() {
    let velocity = [0.3, -0.2, 0.1];
    let gravity = [0.0, 0.0, -9.81];
    for nx in [1, 2] {
        let mesh = Structured { kind: ElementKind::Hex8, n: [nx, 1, 1] }.box_([1.0, 0.1, 0.1]);
        let sets = sets_of(&mesh);
        let bodies = one_body();
        let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
        p.loads = vec![Load::Gravity { g: gravity }];
        let nominal = 0.9 * critical_step(&p);
        for ratio in [0.25, 1.6, 2.25] {
            let t_end = ratio * nominal;
            let step = Step::Explicit {
                t_end,
                dt_factor: 0.9,
                initial_velocity: Some(velocity.repeat(mesh.n_nodes())),
                output_every: 2,
            };
            let res = run_step(&p, &step).expect("stable rigid free fall");
            assert!(res.scalars["dt"] <= 0.9 * res.scalars["dt_crit"]);
            let h = res.history.as_ref().unwrap();
            assert_eq!(*h.times.last().unwrap(), t_end);
            for (&time, values) in h.times.iter().zip(&h.values) {
                for (i, displacement) in values.iter().enumerate() {
                    let c = i % 3;
                    let want = velocity[c] * time + 0.5 * gravity[c] * time * time;
                    assert!(
                        (displacement - want).abs() <= 1e-10 * t_end,
                        "nx={nx}, ratio={ratio}: u={displacement} vs {want} at {time}"
                    );
                }
            }
        }
    }
}

/// One NAFEMS T3 run: the temperature at x = 0.08 m at `t_end`, the step it used, and how many
/// history rows it kept.
fn t3_probe(theta: f64, dt: f64, t_end: f64) -> (f64, f64, usize) {
    let length = 0.1;
    let mesh = Structured { kind: ElementKind::Quad4, n: [20, 1, 1] }.box_([length, 0.005, 0.0]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = heat_problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::PlaneStrain,
        conductor(35.0, 7200.0, 440.5),
        // The driven face is at x = L and the held-cold one at x = 0, so the published probe
        // "x = 0.08 m" is the point 20 mm inside the driven surface.
        vec![hold("driven", "xmax", 100.0), hold("cold", "xmin", 0.0)],
        Vec::new(),
    );
    let step = Step::HeatTransient {
        dt,
        t_end,
        theta,
        initial: 0.0,
        output_every: 1,
        // 100 sin(π t / 40) is a period of 80 s on a prescribed 100 K.
        amplitude: Some(procedure::Amplitude::Sine { amplitude: 1.0, period: 80.0 }),
        solver: SolveOptions::default(),
        control: NonlinearControl::default(),
    };
    let res = run_step(&p, &step).expect("a well-posed transient");
    let rows = res.history.as_ref().expect("a transient keeps a history").times.len();
    (temperature_at(&mesh, &res, [0.08, 0.0025, 0.0]), res.scalars["dt"], rows)
}

/// A transient Step with no clock is a schema error naming the field, and a table amplitude
/// interpolates, holds flat outside itself, and reduces to a constant with one row.
#[test]
fn a_transient_needs_a_positive_step_and_reads_its_amplitude_table() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [2, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = heat_problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        conductor(45.0, 7800.0, 460.0),
        vec![hold("left", "xmin", 300.0), hold("right", "xmax", 400.0)],
        Vec::new(),
    );
    let bad = Step::HeatTransient {
        dt: 0.0,
        t_end: 1.0,
        theta: 0.5,
        initial: 300.0,
        output_every: 1,
        amplitude: None,
        solver: SolveOptions::default(),
        control: NonlinearControl::default(),
    };
    let e = run_step(&p, &bad).expect_err("a zero step");
    assert_eq!(e.code, ErrorCode::Schema);

    // A table amplitude that switches the driven end on over the first second, kept flat after.
    let table = procedure::Amplitude::Table { t: vec![0.0, 1.0, 2.0], value: vec![0.0, 1.0, 1.0] };
    assert_eq!(table.at(-1.0), 0.0);
    assert!((table.at(0.5) - 0.5).abs() < 1e-15);
    assert_eq!(table.at(9.0), 1.0);
    let sine = procedure::Amplitude::Sine { amplitude: 2.0, period: 4.0 };
    assert!((sine.at(1.0) - 2.0).abs() < 1e-12);

    let step = Step::HeatTransient {
        dt: 0.25,
        t_end: 2.0,
        theta: 1.0,
        initial: 300.0,
        output_every: 4,
        amplitude: Some(table),
        solver: SolveOptions::default(),
        control: NonlinearControl::default(),
    };
    let res = run_step(&p, &step).expect("a well-posed transient");
    let h = res.history.as_ref().expect("a history");
    // Rows at t = 0, 1 and 2, and the driven end reaches its full value only after the ramp.
    assert_eq!(h.times.len(), 3);
    assert!((h.values[0][0] - 0.0).abs() < 1e-12, "the ramp starts at zero: {}", h.values[0][0]);
    assert_eq!(res.scalars["steps"], 8.0);
}

/// Benchmark B4: the first three bending modes of a slender hex20 cantilever in one plane,
/// against Euler–Bernoulli. The square section makes every bending mode a pair, so the modes
/// are filtered by the direction their shape actually moves in.
#[test]
fn a_slender_cantilever_has_the_euler_bernoulli_bending_frequencies() {
    let (length, side) = (1.0, 0.05);
    let mesh = Structured { kind: ElementKind::Hex20, n: [20, 2, 2] }.box_([length, side, side]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("root", "xmin", [true, true, true], 0.0)],
    );
    let step = Step::Modal { n_modes: 8, shift: None, solver: SolveOptions::default() };
    let res = run_step(&p, &step).expect("a clamped cantilever has modes");
    // A square section makes every bending mode a degenerate pair, and any rotation of a
    // degenerate pair is as good an eigenvector, so the shapes cannot be split by direction.
    // What is well defined is the pair itself: keep transverse modes and drop the second of any
    // two frequencies within 1 % of each other, which leaves one mode per bending plane.
    let mut in_plane: Vec<f64> = Vec::new();
    for (f, shape) in res.frequencies.iter().zip(&res.modes) {
        let amp = |c: usize| shape.component(c).iter().fold(0.0f64, |m, v| m.max(v.abs()));
        let transverse = amp(1).max(amp(2)) > 2.0 * amp(0);
        if transverse && in_plane.last().is_none_or(|last| (f - last).abs() > 0.01 * last) {
            in_plane.push(*f);
        }
    }
    let i = side.powi(4) / 12.0;
    let area = side * side;
    let base = (YOUNG * i / (DENSITY * area * length.powi(4))).sqrt();
    let wanted: Vec<f64> = [1.8751, 4.6941, 7.8548].iter().map(|b| b * b / (2.0 * PI) * base).collect();
    assert!(in_plane.len() >= 3, "expected three bending modes in one plane, got {in_plane:?}");
    for (i, tol) in [(0usize, 0.015), (1, 0.03), (2, 0.03)] {
        let err = (in_plane[i] - wanted[i]).abs() / wanted[i];
        assert!(err <= tol, "mode {} is {} Hz, want {} Hz ({:.2} %)", i + 1, in_plane[i], wanted[i], 100.0 * err);
    }
    // Every shape is M-normalised, so no mode is the zero vector.
    for shape in &res.modes {
        assert!(shape.data.iter().any(|v| v.abs() > 0.0));
    }
}

/// Benchmark C6 (NAFEMS FV32): the first six frequencies of the cantilevered tapered membrane,
/// on the mapped block whose corners are the published ones.
#[test]
fn nafems_fv32_tapered_membrane_has_the_published_frequencies() {
    let want = [44.623, 130.03, 162.70, 246.05, 379.90, 391.44];
    let material = Material {
        law: builtin_law("linear-elastic").expect("built in"),
        props: vec![200e9, 0.3],
        rho: 8000.0,
        alpha: 0.0,
        k: 0.0,
        cp: 0.0,
    };
    let mut worst = Vec::new();
    for n in [[16, 8], [32, 16]] {
        let block = QuadBlock {
            corners: [[0.0, 0.0], [10.0, 2.0], [10.0, 3.0], [0.0, 5.0]],
            edges: [Curve::Line, Curve::Line, Curve::Line, Curve::Line],
            n: [n[0], n[1]],
            grading: [1.0, 1.0],
            tags: [None, None, None, Some("root".into())],
        };
        let mesh = mapped(&[block], ElementKind::Quad8).expect("one straight-edged block");
        let sets = sets_of(&mesh);
        let bodies = one_body();
        let mut p = problem(
            &mesh,
            &sets,
            &bodies,
            Idealisation::PlaneStress { thickness: 0.05 },
            Formulation::Full,
            vec![fix("root", "root", [true, true, false], 0.0)],
        );
        p.materials = vec![material_of(&material)];
        let step = Step::Modal { n_modes: 6, shift: None, solver: SolveOptions::default() };
        let res = run_step(&p, &step).expect("a clamped membrane has modes");
        let errs: Vec<f64> = res.frequencies.iter().zip(want).map(|(got, w)| (got - w).abs() / w).collect();
        worst.push(errs.iter().fold(0.0f64, |m, e| m.max(*e)));
    }
    assert!(worst[0] <= 0.01 && worst[1] <= 0.01, "FV32 frequencies off by {worst:?}");
}

/// A copy of a Material, since `Material` holds a `&'static dyn MaterialLaw` and is not `Clone`.
fn material_of(m: &Material) -> Material {
    Material { law: m.law, props: m.props.clone(), rho: m.rho, alpha: m.alpha, k: m.k, cp: m.cp }
}

/// A completely free block has six frequencies at zero — the rigid modes — and the seventh is a
/// real deformation. The shift is what makes `K − σM` factorisable at all.
#[test]
fn a_free_block_has_six_zero_frequencies() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [2, 2, 2] }.box_([0.1, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    let step = Step::Modal { n_modes: 8, shift: None, solver: SolveOptions::default() };
    let res = run_step(&p, &step).expect("a free body still has modes");
    let seventh = res.frequencies[6];
    for (i, f) in res.frequencies.iter().take(6).enumerate() {
        assert!(*f <= 1e-6 * seventh, "rigid mode {i} is {f} Hz against {seventh} Hz");
    }
    assert!(seventh > 1e3, "the first deformation mode of a 100 mm steel cube: {seventh} Hz");
    assert_eq!(res.frequencies.len(), 8);
    // Mode 1 is also the Result's displacement field, so a VTU export shows it.
    assert_eq!(res.fields[&Field::Displacement], res.modes[0]);
}

/// A modal Step over a Material without a density has no mass matrix, and says so instead of
/// factorising a singular pencil.
#[test]
fn a_modal_step_without_a_density_names_the_missing_property() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([0.1, 0.1, 0.1]);
    let mut sets = sets_of(&mesh);
    sets.insert(
        "all".to_string(),
        ResolvedSet {
            kind: SetKind::Node,
            faces: Vec::new(),
            nodes: (0..mesh.n_nodes() as u32).collect(),
            elems: Vec::new(),
        },
    );
    let bodies = one_body();
    let mut p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("root", "xmin", [true, true, true], 0.0)],
    );
    p.materials[0].rho = 0.0;
    let step = Step::Modal { n_modes: 2, shift: None, solver: SolveOptions::default() };
    let e = run_step(&p, &step).expect_err("no density, no mass");
    assert_eq!(e.code, ErrorCode::ModelIllPosed);
    assert!(e.cause.contains("density"), "{}", e.cause);

    // An explicit Step has the same problem and reports it the same way.
    let boom = Step::Explicit { t_end: 1e-3, dt_factor: 0.9, initial_velocity: None, output_every: 1 };
    let e = run_step(&p, &boom).expect_err("no density, no time step");
    assert_eq!(e.code, ErrorCode::ModelIllPosed);

    // Holding every DOF removes the per-node error, but a wholly massless model still has no
    // frequency from which explicit dynamics could choose a time step.
    p.constraints = vec![fix("all", "all", [true, true, true], 0.0)];
    let e = run_step(&p, &boom).expect_err("a fully held massless model still has no time scale");
    assert_eq!(e.where_.as_deref(), Some("materials"));
    assert!(e.suggestion.as_deref().is_some_and(|s| s.contains("rho")));
}

/// A massive Body can give the model a finite frequency while a separate massless Body still
/// leaves zero nodal masses. Explicit dynamics rejects those free DOFs before its first divide;
/// correcting the material on the same Problem then runs, which proves the failure is recoverable.
#[test]
fn explicit_rejects_a_free_massless_body_in_a_mixed_model_and_recovers() {
    let a = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([0.1, 0.1, 0.1]);
    let b = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([0.1, 0.1, 0.1]);
    let n_a = a.n_nodes() as u32;
    let mut coords = a.coords.clone();
    for xyz in b.coords.chunks_exact(3) {
        coords.extend([xyz[0] + 0.2, xyz[1], xyz[2]]);
    }
    let mesh = Mesh {
        dim: 3,
        coords,
        blocks: vec![
            femlab_geometry::ElementBlock { kind: ElementKind::Hex8, conn: a.blocks[0].conn.clone(), first_elem: 0 },
            femlab_geometry::ElementBlock {
                kind: ElementKind::Hex8,
                conn: b.blocks[0].conn.iter().map(|&node| node + n_a).collect(),
                first_elem: 1,
            },
        ],
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::new(),
        face_sets: BTreeMap::new(),
    };
    let sets = BTreeMap::from([(
        "massless".to_string(),
        ResolvedSet {
            kind: SetKind::Node,
            faces: Vec::new(),
            nodes: (n_a..n_a + b.n_nodes() as u32).collect(),
            elems: Vec::new(),
        },
    )]);
    let bodies = vec!["massive".to_string(), "massless".to_string()];
    let mut p = Problem {
        mesh: &mesh,
        sets: &sets,
        body_of_block: &bodies,
        material_of_block: vec![Some(0), Some(1)],
        materials: vec![steel(), conductor(0.0, 0.0, 0.0)],
        section_of_block: vec![None, None],
        sections: Vec::new(),
        idealisation: Idealisation::Solid3d,
        formulation: Formulation::Full,
        constraints: Vec::new(),
        couplings: Vec::new(),
        points: Vec::new(),
        loads: Vec::new(),
        temperature: None,
        heat: false,
        heat_loads: Vec::new(),
    };
    let step = Step::Explicit { t_end: 1e-8, dt_factor: 0.9, initial_velocity: None, output_every: 1 };
    let e = run_step(&p, &step).expect_err("the second Body has free DOFs with no mass");
    assert_eq!(e.code, ErrorCode::ModelIllPosed);
    assert_eq!(e.where_.as_deref(), Some("node 8.ux"));
    assert!(e.cause.contains("positive mass at every free DOF"), "{}", e.cause);
    assert!(e.suggestion.as_deref().is_some_and(|s| s.contains("material.assign")));

    p.materials[1].rho = -1.0;
    let e = run_step(&p, &step).expect_err("negative density must not enter explicit assembly");
    assert_eq!(e.where_.as_deref(), Some("material.rho"));
    assert!(e.cause.contains("non-negative"), "{}", e.cause);

    p.materials[1].rho = 0.0;
    p.constraints = vec![fix("hold-massless", "massless", [true, true, true], 0.0)];
    let constrained = run_step(&p, &step).expect("zero mass is supported when all of its DOFs are held");
    assert!(constrained.fields[&Field::Displacement].data.iter().all(|v| v.is_finite()));

    p.constraints.clear();
    p.materials[1].rho = DENSITY;
    let result = run_step(&p, &step).expect("the corrected model remains usable");
    assert!(result.scalars["dt"].is_finite());
    assert!(result.fields[&Field::Displacement].data.iter().all(|v| v.is_finite()));
}

/// Positive assembled nodal mass is not enough to make a zero-density element safe: its
/// stiffness has no local mass from which to derive the element CFL bound. Two overlapping
/// blocks make that distinction exact because the massive block supplies mass at every node.
#[test]
fn explicit_rejects_massless_stiffness_even_when_shared_nodes_have_mass() {
    let one = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([0.1, 0.1, 0.1]);
    let mesh = Mesh {
        dim: 3,
        coords: one.coords.clone(),
        blocks: vec![
            femlab_geometry::ElementBlock { kind: ElementKind::Hex8, conn: one.blocks[0].conn.clone(), first_elem: 0 },
            femlab_geometry::ElementBlock { kind: ElementKind::Hex8, conn: one.blocks[0].conn.clone(), first_elem: 1 },
        ],
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::new(),
        face_sets: BTreeMap::new(),
    };
    let sets = BTreeMap::new();
    let bodies = vec!["massive".to_string(), "massless-stiffener".to_string()];
    let p = Problem {
        mesh: &mesh,
        sets: &sets,
        body_of_block: &bodies,
        material_of_block: vec![Some(0), Some(1)],
        materials: vec![steel(), conductor(0.0, 0.0, 0.0)],
        section_of_block: vec![None, None],
        sections: Vec::new(),
        idealisation: Idealisation::Solid3d,
        formulation: Formulation::Full,
        constraints: Vec::new(),
        couplings: Vec::new(),
        points: Vec::new(),
        loads: Vec::new(),
        temperature: None,
        heat: false,
        heat_loads: Vec::new(),
    };
    let step = Step::Explicit { t_end: 1e-8, dt_factor: 0.9, initial_velocity: None, output_every: 1 };
    let e = run_step(&p, &step).expect_err("massless stiffness makes the local CFL bound undefined");
    assert_eq!(e.code, ErrorCode::ModelIllPosed);
    assert_eq!(e.where_.as_deref(), Some("element 1"));
    assert!(e.cause.contains("finite explicit frequency bound is undefined"), "{}", e.cause);
    assert!(e.suggestion.as_deref().is_some_and(|s| s.contains("constraint.fix")));
}

/// Benchmark F1: a free block given a rigid-body velocity keeps its momentum and its energy for
/// two thousand explicit steps. `v = v₀ + ω × (x − c)` is in the null space of `K`, so a
/// correct integrator moves it and never strains it.
#[test]
fn a_free_block_conserves_momentum_and_energy_under_explicit_integration() {
    let side = 0.1;
    let mesh = Structured { kind: ElementKind::Hex8, n: [4, 4, 4] }.box_([side, side, side]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    let (v0, omega, centre) = ([1.0, 2.0, 3.0], [0.5, -1.0, 2.0], [0.5 * side; 3]);
    let mut v = vec![0.0; mesh.n_nodes() * 3];
    for node in 0..mesh.n_nodes() {
        let x = mesh.node(node as u32);
        let r = [x[0] - centre[0], x[1] - centre[1], x[2] - centre[2]];
        let spin =
            [omega[1] * r[2] - omega[2] * r[1], omega[2] * r[0] - omega[0] * r[2], omega[0] * r[1] - omega[1] * r[0]];
        for c in 0..3 {
            v[node * 3 + c] = v0[c] + spin[c];
        }
    }
    // A first, tiny run reads the critical step, so the case really is "2000 steps at 0.9 Δt".
    let probe_step =
        Step::Explicit { t_end: 1.0, dt_factor: 0.9, initial_velocity: Some(v.clone()), output_every: 1_000_000 };
    let dt = match &probe_step {
        Step::Explicit { dt_factor, .. } => *dt_factor,
        _ => 0.0,
    } * critical_step(&p);
    let step = Step::Explicit { t_end: 2000.0 * dt, dt_factor: 0.9, initial_velocity: Some(v), output_every: 500 };
    let res = run_step(&p, &step).expect("a free block integrates");
    assert_eq!(res.scalars["steps"], 2000.0);
    assert!(res.scalars["momentum_change"] <= 1e-6, "Δp/|p₀| = {}", res.scalars["momentum_change"]);
    assert!(res.scalars["energy_drift"] <= 0.01, "energy drift {}", res.scalars["energy_drift"]);
    // The momentum itself is the block's mass times v₀, which is the independent check that the
    // conserved quantity is the right one.
    let mass = DENSITY * side.powi(3);
    for (c, axis) in ["x", "y", "z"].iter().enumerate() {
        let got = res.scalars[&format!("momentum_{axis}")];
        assert!((got - mass * v0[c]).abs() <= 1e-9 * mass * v0[c], "p{axis} = {got}, want {}", mass * v0[c]);
    }
    assert_eq!(res.history.as_ref().expect("a history").times.len(), 5);
}

/// The critical time step of a Problem, read off a one-step run.
fn critical_step(p: &Problem<'_>) -> f64 {
    let probe = Step::Explicit { t_end: 1e-12, dt_factor: 1.0, initial_velocity: None, output_every: 1 };
    run_step(p, &probe).expect("one step").scalars["dt_crit"]
}

/// Benchmark F2: the estimated critical step really is critical. At 0.9 of it the cantilever
/// rings for five thousand steps; at 1.25 the energy runs away and the Step says `unstable`.
#[test]
fn the_critical_time_step_separates_a_ringing_beam_from_a_diverging_one() {
    let mesh = cantilever_mesh([8, 2, 2], ElementKind::Hex8);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let mut p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("root", "xmin", [true, true, true], 0.0)],
    );
    p.loads = vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -1e5] }];
    let dt_crit = critical_step(&p);
    let stable =
        Step::Explicit { t_end: 5000.0 * 0.9 * dt_crit, dt_factor: 0.9, initial_velocity: None, output_every: 1000 };
    let res = run_step(&p, &stable).expect("0.9 Δt_crit is stable");
    assert_eq!(res.scalars["steps"], 5000.0);
    assert!(res.scalars["energy_max"].is_finite());
    assert!((res.scalars["dt"] - 0.9 * dt_crit).abs() <= 1e-15 * dt_crit);

    let unstable =
        Step::Explicit { t_end: 500.0 * 1.25 * dt_crit, dt_factor: 1.25, initial_velocity: None, output_every: 1 };
    let e = run_step(&p, &unstable).expect_err("1.25 Δt_crit diverges");
    assert_eq!(e.code, ErrorCode::ExplicitUnstable);
    assert!(e.cause.contains("diverged at step"), "{}", e.cause);
}

// ------------------------------------------------------ F5–F10: dynamics verification (#396)
//
// A time integrator with a sign error, an off-by-one in the start-up or a wrong mass scaling
// still produces smooth, plausible curves. Every gate below is chosen to tell a right
// integrator from a nearly-right one: each compares against a closed form derived in the
// test, and the strongest compare the integrator's *own* error against what theory predicts.

/// A rod-like Material: ν = 0, so the wave speed is exactly `√(E/ρ)` and a hex8 corner's
/// diagonal stiffness is a closed form. Structural Steps never read `k` or `cp`.
fn rod_material(e: f64, rho: f64) -> Material {
    Material {
        law: builtin_law("linear-elastic").expect("built in"),
        props: vec![e, 0.0],
        rho,
        alpha: 0.0,
        k: 45.0,
        cp: 460.0,
    }
}

const SDOF_E: f64 = 225e9;
const SDOF_RHO: f64 = 8000.0;
const SDOF_SIDE: f64 = 0.1;
const SDOF_V0: f64 = 1.0;

/// One hex8 cube with every DOF held except `ux` of the corner at `(a, a, a)`: a single
/// degree of freedom whose stiffness and mass are closed forms. With ν = 0 the corner's
/// diagonal stiffness is `∫ E (∂N/∂x)² + G (∂N/∂y)² + G (∂N/∂z)² dV = a (E + 2G)/9 = 2Ea/9`
/// (the integrand is quadratic per direction, so 2×2×2 Gauss is exact) and its HRZ mass is
/// `ρa³/8`, so `ω = (4/3) √(E/ρ) / a`. Both are asserted against the assembly once.
struct Sdof {
    mesh: Mesh,
    sets: BTreeMap<String, ResolvedSet>,
    bodies: Vec<String>,
    dof: usize,
    k: f64,
    m: f64,
    omega: f64,
}

fn sdof() -> Sdof {
    let a = SDOF_SIDE;
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([a; 3]);
    let sets = sets_of(&mesh);
    let corner = node_at(&mesh, [a; 3]) as usize;
    let (k, m) = (2.0 * SDOF_E * a / 9.0, SDOF_RHO * a * a * a / 8.0);
    let s = Sdof { mesh, sets, bodies: one_body(), dof: corner * 3, k, m, omega: (k / m).sqrt() };
    let p = sdof_problem(&s);
    let (pat, a) = assemble(&p);
    let lumped = femlab_engine::procedure::modal::assemble_mass(&p, &pat, true).expect("a lumped mass").diag();
    assert!((a.k.diag()[s.dof] - k).abs() <= 1e-12 * k, "corner stiffness {} vs closed form {k}", a.k.diag()[s.dof]);
    assert!((lumped[s.dof] - m).abs() <= 1e-12 * m, "corner mass {} vs closed form {m}", lumped[s.dof]);
    s
}

fn sdof_problem(s: &Sdof) -> Problem<'_> {
    let constraints = vec![
        fix("x0", "xmin", [true; 3], 0.0),
        fix("y0", "ymin", [true; 3], 0.0),
        fix("z0", "zmin", [true; 3], 0.0),
        fix("axial", "xmax", [false, true, true], 0.0),
    ];
    let mut p = problem(&s.mesh, &s.sets, &s.bodies, Idealisation::Solid3d, Formulation::Full, constraints);
    p.materials = vec![rod_material(SDOF_E, SDOF_RHO)];
    p
}

/// Integrate the oscillator from `u = 0, v = V0` until `t_end` at `ωΔt` as close to `x` as the
/// endpoint allows, every step retained. Returns the step actually taken, the times and the
/// free DOF's history.
fn sdof_run(s: &Sdof, x: f64, t_end: f64) -> Result<(f64, Vec<f64>, Vec<f64>), Error> {
    let p = sdof_problem(s);
    let dt_factor = x / s.omega / critical_step(&p);
    let mut v0 = vec![0.0; s.mesh.n_nodes() * 3];
    v0[s.dof] = SDOF_V0;
    let step = Step::Explicit { t_end, dt_factor, initial_velocity: Some(v0), output_every: 1 };
    let res = run_step(&p, &step)?;
    let h = res.history.expect("every step is retained");
    let u = h.values.iter().map(|frame| frame[s.dof]).collect();
    Ok((res.scalars["dt"], h.times, u))
}

/// The mean period between the upward zero crossings of a sampled oscillation, each crossing
/// placed by linear interpolation. A sinusoid has no curvature at its zeros, so the placement
/// error is third order in the sample spacing — `(ωΔt)²Δt/16` per crossing — and is amortised
/// over every cycle in the record: below 1e-4 of the period at `ωΔt = 1` over a hundred cycles.
fn zero_crossing_period(times: &[f64], u: &[f64]) -> f64 {
    let crossings: Vec<f64> = (1..u.len())
        .filter(|&i| u[i - 1] < 0.0 && u[i] >= 0.0)
        .map(|i| times[i - 1] + (times[i] - times[i - 1]) * u[i - 1] / (u[i - 1] - u[i]))
        .collect();
    assert!(crossings.len() >= 2, "not enough cycles: {} crossings", crossings.len());
    (crossings[crossings.len() - 1] - crossings[0]) / (crossings.len() - 1) as f64
}

/// The least-squares line through `(x, y)`: `(slope, intercept)`.
fn line_fit(x: &[f64], y: &[f64]) -> (f64, f64) {
    let n = x.len() as f64;
    let (mx, my) = (x.iter().sum::<f64>() / n, y.iter().sum::<f64>() / n);
    let sxy: f64 = x.iter().zip(y).map(|(a, b)| (a - mx) * (b - my)).sum();
    let sxx: f64 = x.iter().map(|a| (a - mx).powi(2)).sum();
    let slope = sxy / sxx;
    (slope, my - slope * mx)
}

/// Benchmark F5: the integrator's own period error, predicted exactly. Central differences on
/// `ü = −ω²u` obey `sin(ω̃Δt/2) = ωΔt/2`, so the period is *shorter* than `2π/ω` by
/// `(ωΔt)²/24` to leading order (the trapezoidal rule lengthens it by twice that). The period
/// measured over a hundred cycles must match the dispersion relation at each of three steps,
/// and the coefficient fitted from the three must be −1/24. A start-up kick of the wrong
/// half-step, a velocity update lagging one step, or a mass off by a factor all keep a clean
/// sinusoid and fail here.
#[test]
fn central_differences_shorten_the_period_by_omega_dt_squared_over_24() {
    let s = sdof();
    let cycles = 100.0 * 2.0 * PI / s.omega;
    let (mut xx, mut yy) = (Vec::new(), Vec::new());
    for x in [0.25, 0.5, 1.0] {
        let (dt, times, u) = sdof_run(&s, x, cycles).expect("a stable oscillator");
        let x = s.omega * dt;
        let period = zero_crossing_period(&times, &u);
        let dispersion = PI * dt / libm::asin(0.5 * x);
        assert!((period - dispersion).abs() <= 1e-4 * dispersion, "ωΔt = {x}: T = {period}, theory {dispersion}");
        xx.push(x * x);
        yy.push((period * s.omega / (2.0 * PI) - 1.0) / (x * x));
    }
    // ΔT/T ÷ (ωΔt)² = c + d (ωΔt)² + …: the intercept of the fitted line is the coefficient.
    let (_, c) = line_fit(&xx, &yy);
    let want = -1.0 / 24.0;
    assert!((c - want).abs() <= 0.01 * want.abs(), "ΔT/T = c (ωΔt)² with c = {c}; theory {want}");
    println!("F5 period coefficient: measured {c:.6}, theory {want:.6}, ratio {}", c / want);
}

/// Benchmark F6: central differences conserve a discrete energy *exactly* for a linear
/// system. `½ v_{n+½}ᵀ M v_{n+½} + ½ u_nᵀ K u_{n+1}` is the same number at every step, to
/// round-off (the integrator's own `½vᵀMv + ½uᵀKu` monitor oscillates by O(Δt²) and is only
/// bounded, which is why it is not the gate). The oscillator starts at `½ m v₀²` and keeps
/// exactly that for a hundred cycles at `ωΔt = 1`; the F2 cantilever with a random initial
/// velocity keeps its own, computed from the retained frames and the assembled `K` and `M`.
#[test]
fn central_differences_conserve_the_discrete_energy_to_round_off() {
    let s = sdof();
    let (dt, _, u) = sdof_run(&s, 1.0, 100.0 * 2.0 * PI / s.omega).expect("stable at ωΔt = 1");
    let q0 = 0.5 * s.m * SDOF_V0 * SDOF_V0;
    let worst = u
        .windows(2)
        .map(|w| {
            let v = (w[1] - w[0]) / dt;
            (0.5 * s.m * v * v + 0.5 * s.k * w[0] * w[1] - q0).abs()
        })
        .fold(0.0, f64::max);
    assert!(worst <= 1e-12 * q0, "the discrete energy wanders by {worst} of {q0}");

    let mesh = cantilever_mesh([8, 2, 2], ElementKind::Hex8);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let root = vec![fix("root", "xmin", [true; 3], 0.0)];
    let p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, root);
    let (pat, a) = assemble(&p);
    let mass = femlab_engine::procedure::modal::assemble_mass(&p, &pat, true).expect("a lumped mass").diag();
    let v0 = lcg_vec(mesh.n_nodes() * 3, 396);
    let dt = 0.9 * critical_step(&p);
    let step = Step::Explicit { t_end: 500.0 * dt, dt_factor: 0.9, initial_velocity: Some(v0), output_every: 1 };
    let res = run_step(&p, &step).expect("a ringing beam");
    let (dt, h) = (res.scalars["dt"], res.history.expect("frames"));
    let mut ku = vec![0.0; a.k.n];
    let q: Vec<f64> = h
        .values
        .windows(2)
        .map(|w| {
            a.k.spmv(&w[1], &mut ku);
            let strain: f64 = w[0].iter().zip(&ku).map(|(u, ku)| 0.5 * u * ku).sum();
            let kinetic: f64 =
                mass.iter().zip(w[0].iter().zip(&w[1])).map(|(m, (u0, u1))| 0.5 * m * ((u1 - u0) / dt).powi(2)).sum();
            strain + kinetic
        })
        .collect();
    let (lo, hi) = q.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &e| (lo.min(e), hi.max(e)));
    assert!(hi - lo <= 1e-10 * q[0], "the beam's discrete energy spans [{lo}, {hi}]");
    println!("F6 discrete energy: SDOF wander {:.2e}, beam wander {:.2e}", worst / q0, (hi - lo) / q[0]);
}

/// Benchmark F7: the stability boundary is sharp at `ωΔt = 2`. Two per cent below it the
/// oscillator is bounded and its sampled amplitude is the closed form
/// `v₀ / (ω √(1 − (ωΔt/2)²))`, which is already five times the continuum amplitude; two per
/// cent above it the integration diverges and the Step says `explicit.unstable`. F2 checks
/// the estimator on a beam at 0.9 and 1.25; this checks the integrator against the number.
#[test]
fn the_stability_boundary_is_sharp_at_omega_dt_two() {
    let s = sdof();
    let steps = 1000.0;
    let (dt, _, u) = sdof_run(&s, 1.96, steps * 1.96 / s.omega).expect("bounded below the boundary");
    let x = s.omega * dt;
    assert!(x > 1.95 && x < 2.0, "ωΔt = {x}");
    let amplitude = SDOF_V0 / (s.omega * (1.0 - 0.25 * x * x).sqrt());
    let peak = u.iter().fold(0.0, |m: f64, v| m.max(v.abs()));
    assert!(peak <= amplitude * (1.0 + 1e-9), "sampled peak {peak} exceeds the closed form {amplitude}");
    assert!(peak >= 0.99 * amplitude, "sampled peak {peak} never reaches the closed form {amplitude}");
    let e = sdof_run(&s, 2.04, steps * 2.04 / s.omega).expect_err("diverges above the boundary");
    assert_eq!(e.code, ErrorCode::ExplicitUnstable);
    println!("F7 stability: ωΔt = {x} peak/closed-form = {}, ωΔt = 2.04 → {}", peak / amplitude, e.code);
}

/// Benchmark F8: second order in Δt. Against the exact `u = (v₀/ω) sin ωt` at `t = 5⅛ T`,
/// where the phase error is what shows, halving the step from `ωΔt = 0.2` to `0.05` must
/// quarter the error: the observed rate is gated above 1.9. A first-order start-up (a missing
/// half-step kick) shows here as a rate near one.
#[test]
fn explicit_dynamics_converges_at_second_order_in_dt() {
    let s = sdof();
    let t_end = 5.125 * 2.0 * PI / s.omega;
    let exact = SDOF_V0 / s.omega * libm::sin(s.omega * t_end);
    let (mut dts, mut errs) = (Vec::new(), Vec::new());
    for x in [0.2, 0.1, 0.05] {
        let (dt, _, u) = sdof_run(&s, x, t_end).expect("a stable oscillator");
        dts.push(dt);
        errs.push((u[u.len() - 1] - exact).abs());
    }
    let rate = observed_rate(&dts, &errs);
    assert!(rate >= 1.9, "observed rate {rate} from errors {errs:?}");
    println!("F8 convergence in Δt: rate {rate:.4}, errors {errs:?}");
}

const ROD_E: f64 = 200e9;
const ROD_RHO: f64 = 8000.0;

/// A bar of `n` hex8 along x with ν = 0 and every lateral DOF held is exactly the 1-D rod
/// `ρü = Eu''` with `c = √(E/ρ) = 5000 m/s`: uniform-over-the-section motion strains only
/// `ε_xx`, and each section's four nodes carry a quarter of the rod's force and mass.
fn rod_mesh(n: usize, length: f64) -> (Mesh, BTreeMap<String, ResolvedSet>) {
    let mesh = Structured { kind: ElementKind::Hex8, n: [n, 1, 1] }.box_([length, 0.05, 0.05]);
    let sets = sets_of(&mesh);
    (mesh, sets)
}

fn rod_problem<'a>(mesh: &'a Mesh, sets: &'a BTreeMap<String, ResolvedSet>, bodies: &'a [String]) -> Problem<'a> {
    let held = vec![fix("root", "xmin", [true; 3], 0.0), fix("lateral", "all", [false, true, true], 0.0)];
    let mut p = problem(mesh, sets, bodies, Idealisation::Solid3d, Formulation::Full, held);
    p.materials = vec![rod_material(ROD_E, ROD_RHO)];
    p
}

/// Benchmark F9: an elastic wave arrives when the theory says. A step traction `σ₀` on the
/// free end of a fixed-free rod sends a front toward the root at `c = √(E/ρ)`; behind it the
/// material moves at `σ₀/(ρc)`. At mid-length the front arrives at `L/2c` and the reflection
/// from the root returns at `3L/2c`, so a line fitted to the ramp between them gives the
/// arrival time (its zero) and the wave speed (its slope); both are gated on two meshes.
/// Nothing may move before the front: lumped-mass central differences have no precursor.
#[test]
fn a_step_front_arrives_at_l_over_c_and_ramps_at_sigma_over_rho_c() {
    let (length, sigma) = (1.0, 200e6);
    let c = (ROD_E / ROD_RHO).sqrt();
    let transit = length / c;
    let particle = sigma / (ROD_RHO * c);
    for n in [100usize, 200] {
        let (mesh, sets) = rod_mesh(n, length);
        let bodies = one_body();
        let mut p = rod_problem(&mesh, &sets, &bodies);
        p.loads = vec![Load::Traction { faces: "xmax".into(), t: [sigma, 0.0, 0.0] }];
        let step = Step::Explicit { t_end: 1.5 * transit, dt_factor: 0.9, initial_velocity: None, output_every: 1 };
        let h = run_step(&p, &step).expect("a bar rings").history.expect("frames");
        let mid = node_at(&mesh, [0.5 * length, 0.0, 0.0]) as usize * 3;
        let u: Vec<f64> = h.values.iter().map(|f| f[mid]).collect();
        let (t, w): (Vec<f64>, Vec<f64>) =
            h.times.iter().zip(&u).filter(|(t, _)| (0.75 * transit..=1.25 * transit).contains(*t)).unzip();
        let (slope, intercept) = line_fit(&t, &w);
        let arrival = -intercept / slope;
        assert!(
            (arrival - 0.5 * transit).abs() <= 0.005 * 0.5 * transit,
            "n = {n}: arrival {arrival} vs {}",
            0.5 * transit
        );
        assert!((slope - particle).abs() <= 0.005 * particle, "n = {n}: particle velocity {slope} vs {particle}");
        let quiet =
            h.times.iter().zip(&u).filter(|(t, _)| **t <= 0.4 * transit).fold(0.0, |m: f64, (_, u)| m.max(u.abs()));
        assert!(quiet <= 1e-6 * particle * transit, "n = {n}: {quiet} m moved before the front");
        println!(
            "F9 wave n = {n}: arrival {:.5} L/c (theory 0.5), c from slope {:.2} m/s (theory {c}), precursor {quiet:.1e} m",
            arrival / transit,
            sigma / (ROD_RHO * slope)
        );
    }
}

/// Cross-solver: the modal frequencies equal the spectrum of a free-vibration history. The
/// modal Step (consistent mass, shifted inverse iteration) and the explicit Step (lumped
/// mass, central differences) discretise the rod differently, and the j-th fixed-free mode
/// `sin kx`, `k = (2j−1)π/2L`, is an exact eigenvector of both chains: consistent
/// `ω² = (6c²/h²)(1 − cos kh)/(2 + cos kh)`, lumped `ω = (2c/h) sin(kh/2)`, then shortened by
/// the F5 dispersion. Each is gated against its own closed form and the two against each
/// other to the gap those closed forms predict. A modal solver in rad/s, or an explicit
/// integrator with its mass scaled wrongly, disagrees with the other by far more.
#[test]
fn modal_frequencies_equal_the_spectrum_of_an_explicit_free_vibration() {
    let (n, length) = (20usize, 1.0);
    let (mesh, sets) = rod_mesh(n, length);
    let bodies = one_body();
    let p = rod_problem(&mesh, &sets, &bodies);
    let (c, h) = ((ROD_E / ROD_RHO).sqrt(), length / n as f64);
    let modal = Step::Modal { n_modes: 3, shift: None, solver: SolveOptions::default() };
    let modal = run_step(&p, &modal).expect("three rod modes");
    let tip = node_at(&mesh, [length, 0.0, 0.0]) as usize * 3;
    for j in 0..3 {
        let k = (2 * j + 1) as f64 * PI / (2.0 * length);
        let ck = libm::cos(k * h);
        let w_consistent = c / h * (6.0 * (1.0 - ck) / (2.0 + ck)).sqrt();
        let w_lumped = 2.0 * c / h * libm::sin(0.5 * k * h);
        let w_modal = 2.0 * PI * modal.frequencies[j];
        assert!((w_modal - w_consistent).abs() <= 1e-6 * w_consistent, "mode {j}: modal {w_modal} vs {w_consistent}");
        let mut v0 = vec![0.0; mesh.n_nodes() * 3];
        for node in 0..mesh.n_nodes() {
            v0[node * 3] = libm::sin(k * mesh.node(node as u32)[0]);
        }
        let t_end = 20.0 * 2.0 * PI / w_lumped;
        let step = Step::Explicit { t_end, dt_factor: 0.9, initial_velocity: Some(v0), output_every: 1 };
        let res = run_step(&p, &step).expect("a rod rings in one mode");
        let (dt, hist) = (res.scalars["dt"], res.history.expect("frames"));
        let u: Vec<f64> = hist.values.iter().map(|f| f[tip]).collect();
        let w_explicit = 2.0 * PI / zero_crossing_period(&hist.times, &u);
        let w_discrete = 2.0 / dt * libm::asin(0.5 * w_lumped * dt);
        assert!(
            (w_explicit - w_discrete).abs() <= 1e-4 * w_discrete,
            "mode {j}: explicit {w_explicit} vs {w_discrete}"
        );
        let (gap, got) = ((w_consistent - w_discrete).abs(), (w_modal - w_explicit).abs());
        assert!((got - gap).abs() <= 1e-4 * w_lumped, "mode {j}: solvers differ by {got}, the closed forms by {gap}");
        println!(
            "F11 mode {}: modal {:.4} Hz, explicit {:.4} Hz, continuum {:.4} Hz, gap {:.2e} (theory {:.2e})",
            j + 1,
            modal.frequencies[j],
            w_explicit / (2.0 * PI),
            c * k / (2.0 * PI),
            got / w_lumped,
            gap / w_lumped
        );
    }
}

/// Benchmark F10: impulse. A free hex8 pushed at one corner by a constant force `F` for a
/// time `τ` carries momentum `Δp = ∫F dt = F(τ + Δt/2)` (the reported velocity is the
/// half-step one) and its mass centre has moved `Fτ²/2M`, both to round-off, while the block
/// itself deforms. Both hold because `Ku` sums to zero over a rigid translation; a stiffness
/// that does not annihilate translation, or a nodal load scattered against the wrong mass,
/// breaks them.
#[test]
fn a_short_push_transfers_exactly_the_impulse() {
    let (a, force) = (0.1, 1e6);
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([a; 3]);
    let mut sets = sets_of(&mesh);
    let corner = node_at(&mesh, [a; 3]);
    sets.insert(
        "corner".into(),
        ResolvedSet { kind: SetKind::Node, faces: Vec::new(), nodes: vec![corner], elems: Vec::new() },
    );
    let bodies = one_body();
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    p.loads = vec![Load::NodalForce { nodes: "corner".into(), f: [force, 0.0, 0.0] }];
    let tau = 500.0 * 0.9 * critical_step(&p);
    let step = Step::Explicit { t_end: tau, dt_factor: 0.9, initial_velocity: None, output_every: 1 };
    let res = run_step(&p, &step).expect("a free block");
    let impulse = force * (tau + 0.5 * res.scalars["dt"]);
    let got = res.scalars["momentum_x"];
    assert!((got - impulse).abs() <= 1e-10 * impulse, "p = {got}, ∫F dt = {impulse}");
    assert!(res.scalars["momentum_y"].abs() <= 1e-12 * impulse && res.scalars["momentum_z"].abs() <= 1e-12 * impulse);
    let mass = DENSITY * a * a * a;
    let centre = res.fields[&Field::Displacement].component(0).iter().sum::<f64>() / 8.0;
    let want = force * tau * tau / (2.0 * mass);
    assert!((centre - want).abs() <= 1e-10 * want, "mass centre moved {centre}, Fτ²/2M = {want}");
    println!(
        "F10 impulse: p/∫F dt − 1 = {:.2e}, centre/(Fτ²/2M) − 1 = {:.2e}",
        got / impulse - 1.0,
        centre / want - 1.0
    );
}

/// An explicit Step with no clock is a schema error naming the field.
#[test]
fn an_explicit_step_needs_a_positive_end_time() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([0.1, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    let step = Step::Explicit { t_end: 0.0, dt_factor: 0.9, initial_velocity: None, output_every: 1 };
    let e = run_step(&p, &step).expect_err("no end time");
    assert_eq!(e.code, ErrorCode::Schema);
    let step = Step::Explicit { t_end: 1.0, dt_factor: f64::INFINITY, initial_velocity: None, output_every: 1 };
    let e = run_step(&p, &step).expect_err("an infinite step factor cannot define a time grid");
    assert_eq!(e.code, ErrorCode::Schema);
    assert_eq!(e.where_.as_deref(), Some("dt"));
}

/// Every heat kernel refuses a folded element, with the same `mesh.inverted` error the elastic
/// ones give: the Jacobian is the same routine.
#[test]
fn the_heat_kernels_reject_a_folded_element() {
    let mat = conductor(45.0, 7800.0, 460.0);
    for kind in ALL_KINDS {
        let coords = folded(kind);
        let n = kind.n_nodes();
        let id = idealisations(kind).swap_remove(0);
        let c = ctx(&coords, &mat, id, Formulation::Full);
        let mut m = vec![0.0; n * n];
        let mut v = vec![0.0; n];
        let fails = [
            femlab_engine::fem::heat::conductivity(kind, &c, &mut m).err(),
            femlab_engine::fem::heat::capacity(kind, &c, &mut m).err(),
            femlab_engine::fem::heat::source(kind, &c, 1.0, &mut v).err(),
        ];
        for e in fails {
            let e = e.expect("a folded element must fail");
            assert_eq!(e.code, ErrorCode::MeshInverted, "{kind:?}");
        }
    }
}

/// The heat and mass assemblies are called by the procedures after the checks have run, so a
/// Problem whose blocks have no material or whose loads name nothing never reaches them; called
/// directly they still report the Body and the Set.
#[test]
fn the_heat_and_mass_assemblies_report_what_the_checks_would_have_caught() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let mut p = heat_problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        conductor(45.0, 7800.0, 460.0),
        vec![hold("left", "xmin", 300.0)],
        vec![
            HeatLoad::Source { bodies: one_body(), q: 1.0 },
            HeatLoad::Convection { faces: "xmax".into(), h: 10.0, t_inf: 300.0 },
        ],
    );
    p.material_of_block = vec![None];
    let pat = pattern(&mesh, 1);
    let none = Mpc::none();
    // The face loop runs first, so with a convection load it is the one that reports the Body.
    assert_eq!(heat::assemble(&p, &pat, &none).expect_err("no material").code, ErrorCode::ModelNoMaterial);
    // Without one, the element loop reports it instead.
    p.heat_loads = vec![HeatLoad::Source { bodies: one_body(), q: 1.0 }];
    assert_eq!(heat::assemble(&p, &pat, &none).expect_err("no material").code, ErrorCode::ModelNoMaterial);
    assert_eq!(heat::assemble_capacity(&p, &pat).expect_err("no material").code, ErrorCode::ModelNoMaterial);
    let e = run_step(&p, &steady()).expect_err("the checks catch it first");
    assert_eq!(e.code, ErrorCode::ModelNoMaterial);
    // The material is there but the convection Set is not: the face loop reports the Set.
    p.material_of_block = vec![Some(0)];
    p.heat_loads = vec![HeatLoad::Convection { faces: "nowhere".into(), h: 10.0, t_inf: 300.0 }];
    assert_eq!(heat::assemble(&p, &pat, &none).expect_err("no such Set").code, ErrorCode::SetEmpty);

    // The thermal-contact loop (#85) integrates the slave faces of the Coupling its `of` names,
    // so it answers for the same two things: the slave Set, then the Body's material.
    p.heat_loads = vec![HeatLoad::Contact { of: "weld".into(), h: 500.0 }];
    p.couplings = vec![tie("weld", "xmin", "nowhere", 1e-9)];
    assert_eq!(heat::assemble(&p, &pat, &none).expect_err("no slave Set").code, ErrorCode::SetEmpty);
    p.couplings = vec![tie("weld", "xmin", "xmax", 1e-9)];
    p.material_of_block = vec![None];
    let no_material = heat::assemble(&p, &pat, &none).expect_err("no material on the slave faces");
    assert_eq!((no_material.code, no_material.where_.as_deref()), (ErrorCode::ModelNoMaterial, Some("element 0")));
    p.material_of_block = vec![Some(0)];
    p.couplings = Vec::new();

    // The radiative face integral answers for the same three things, and it is the one the
    // procedures call with an `expect` on the strength of the checks having run first.
    let mut k = pat.csr.clone();
    let mut f = vec![0.0; mesh.n_nodes()];
    let t = vec![300.0; mesh.n_nodes()];
    p.heat_loads = vec![HeatLoad::Radiation { faces: "nowhere".into(), emissivity: 0.9, t_inf: 300.0 }];
    let missing = heat::add_radiation(&p, &pat, &t, &mut k, &mut f).expect_err("no such Set");
    assert_eq!(missing.code, ErrorCode::SetEmpty);
    p.heat_loads = vec![HeatLoad::Radiation { faces: "xmax".into(), emissivity: 0.9, t_inf: 300.0 }];
    p.material_of_block = vec![None];
    let no_material = heat::add_radiation(&p, &pat, &t, &mut k, &mut f).expect_err("no material");
    assert_eq!((no_material.code, no_material.where_.as_deref()), (ErrorCode::ModelNoMaterial, Some("element 0")));

    // The consistent mass assembly the modal procedure uses reports the same thing.
    let structural = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    let mut no_material = structural;
    no_material.material_of_block = vec![None];
    let pat3 = pattern(&mesh, 3);
    let e =
        femlab_engine::procedure::modal::assemble_mass(&no_material, &pat3, false).expect_err("no material, no mass");
    assert_eq!(e.code, ErrorCode::ModelNoMaterial);
}

/// A material the checks cannot see stops a modal and an explicit Step where the elastic
/// integral calls the law, and a shift above the first eigenvalue makes the shifted matrix
/// indefinite, which the factorisation says out loud.
#[test]
fn a_material_the_checks_cannot_see_stops_the_dynamic_procedures() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [2, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let held = vec![fix("root", "xmin", [true, true, true], 0.0)];
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, held);
    p.materials[0].props = vec![YOUNG];
    let modal = Step::Modal { n_modes: 2, shift: None, solver: SolveOptions::default() };
    assert_eq!(run_step(&p, &modal).expect_err("one prop instead of two").code, ErrorCode::MaterialProps);
    let boom = Step::Explicit { t_end: 1e-5, dt_factor: 0.9, initial_velocity: None, output_every: 1 };
    assert_eq!(run_step(&p, &boom).expect_err("one prop instead of two").code, ErrorCode::MaterialProps);

    p.materials[0].props = vec![YOUNG, POISSON];
    let shifted = Step::Modal { n_modes: 2, shift: Some(1e18), solver: SolveOptions::default() };
    let e = run_step(&p, &shifted).expect_err("a shift far above the spectrum");
    assert_eq!(e.code, ErrorCode::SolveNotPositiveDefinite);
}

/// A host that says stop cancels a transient, a modal and an explicit Step at their own phases.
#[test]
fn a_host_that_says_stop_cancels_every_new_procedure() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [2, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let held = vec![hold("left", "xmin", 300.0), hold("right", "xmax", 400.0)];
    let hot =
        heat_problem(&mesh, &sets, &bodies, Idealisation::Solid3d, conductor(45.0, 7800.0, 460.0), held, Vec::new());
    let solid = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("root", "xmin", [true, true, true], 0.0)],
    );
    let transient = Step::HeatTransient {
        dt: 1.0,
        t_end: 4.0,
        theta: 0.5,
        initial: 300.0,
        output_every: 1,
        amplitude: None,
        solver: SolveOptions::default(),
        control: NonlinearControl::default(),
    };
    let steps: Vec<(&Problem<'_>, Step)> = vec![
        (&hot, steady()),
        (&hot, transient),
        (&solid, Step::Modal { n_modes: 2, shift: Some(-1.0), solver: SolveOptions::default() }),
        (&solid, Step::Explicit { t_end: 1e-5, dt_factor: 0.9, initial_velocity: None, output_every: 1 }),
        (&solid, implicit_step(1e-5, 1e-5, 0.0, (0.0, 0.0), None, 1)),
    ];
    for (p, step) in steps {
        for at in 0..3 {
            let mut go = cancel_on(at);
            let r = pollster::block_on(procedure::run(p, &step, &Pool::new(2), None, None, &mut go));
            if let Err(e) = r {
                assert_eq!(e.code, ErrorCode::Cancelled, "{}", e.cause);
            }
        }
    }
    // A harmonic Step reports at three phases too, and only runs against a modal Result: the
    // assembly (call 0), one solve call per retained frequency (1..=4 here) and the post (5).
    let modal = run_step(&solid, &Step::Modal { n_modes: 2, shift: None, solver: SolveOptions::default() })
        .expect("a bar with mass has modes");
    for at in [0, 1, 4, 5] {
        let mut go = cancel_on(at);
        let step = harmonic_step(10.0, 100.0, 4, 0.02, 1);
        let e = pollster::block_on(procedure::run(&solid, &step, &Pool::new(2), None, Some(&modal), &mut go))
            .expect_err("cancelled");
        assert_eq!(e.code, ErrorCode::Cancelled, "call {at}: {}", e.cause);
    }
    let mut go = cancel_on(6);
    let step = harmonic_step(10.0, 100.0, 4, 0.02, 1);
    pollster::block_on(procedure::run(&solid, &step, &Pool::new(2), None, Some(&modal), &mut go))
        .expect("a host that never says stop gets its sweep");
}

/// A factorization is only a candidate: verify the full original operator independently.
#[test]
fn a_direct_solve_rejects_an_incorrect_or_unrepresentable_answer() {
    use femlab_engine::solve::direct::Direct;
    use femlab_engine::solve::LinearSolve;
    // faer reads the CSR upper triangle as CSC lower: it solves [[2,1],[1,2]],
    // giving (2/3,-1/3). The actual nonsymmetric K below requires (1/2,0), and
    // its residual at faer's candidate is exactly (0,-2/3). Never report success.
    let k = Csr { n: 2, row_ptr: vec![0, 2, 4], col_idx: vec![0, 1, 0, 1], vals: vec![2.0, 1.0, 0.0, 2.0] };
    let mut factor = Direct::factor(&k).unwrap();
    for tolerance in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -1.0, f64::MAX] {
        let mut x = [7.0, 8.0];
        let error = factor.solve_with_tolerance(&[1.0, 0.0], &mut x, tolerance).unwrap_err();
        assert_eq!(error.code, ErrorCode::Schema);
        assert_eq!(error.where_.as_deref(), Some("tolerance"));
        assert_eq!(x, [7.0, 8.0]);
    }
    let error = factor.solve(&[1.0, 0.0], &mut [0.0; 2]).unwrap_err();
    assert_eq!(error.code, ErrorCode::SolveStalled);
    assert_eq!(error.where_.as_deref(), Some("solve"));
    assert!(error.cause.contains("relative residual"));
    assert!(error.suggestion.unwrap().contains("solve.run"));
    // This SPD scalar system has exact x=1e500, beyond f64. Its factor is valid;
    // arithmetic overflow while solving must still be a structured error.
    let k = Csr { n: 1, row_ptr: vec![0, 1], col_idx: vec![0], vals: vec![1e-200] };
    let error = Direct::factor(&k).unwrap().solve(&[1e300], &mut [0.0]).unwrap_err();
    assert_eq!(error.code, ErrorCode::SolveStalled);
    // The exact solution of 3x=b remains representable across changes of force units.
    let k = Csr { n: 1, row_ptr: vec![0, 1], col_idx: vec![0], vals: vec![3.0] };
    let mut factor = Direct::factor(&k).unwrap();
    for b in [1e-300, 1.0, 1e300] {
        let mut x = [0.0];
        let info = factor.solve(&[b], &mut x).unwrap();
        assert!((x[0] / b - 1.0 / 3.0).abs() < 1e-15);
        assert!(info.rel_residual < 1e-14);
    }
}

/// The discrete Dirichlet harmonic problem has exact x_i=(i+1)/(n+1): a linear
/// profile with zero second difference and unit value at the far boundary.
fn direct_harmonic_profile(threads: usize) {
    use femlab_engine::solve::direct::Direct;
    use femlab_engine::solve::LinearSolve;
    let ambient = faer::get_global_parallelism();
    for n in [65, 129, 257] {
        let mut k = Csr { n, row_ptr: vec![0], col_idx: Vec::new(), vals: Vec::new() };
        for i in 0..n {
            if i > 0 {
                k.col_idx.push((i - 1) as u32);
                k.vals.push(-1.0);
            }
            k.col_idx.push(i as u32);
            k.vals.push(2.0);
            if i + 1 < n {
                k.col_idx.push((i + 1) as u32);
                k.vals.push(-1.0);
            }
            k.row_ptr.push(k.vals.len() as u32);
        }
        // The owning factor outlives the temporary pool and scratch used to construct it.
        let mut direct = Pool::new(threads).install(|| Direct::factor(&k)).unwrap();
        assert_eq!(faer::get_global_parallelism(), ambient);
        for boundary in [1.0, -3.0] {
            let mut rhs = vec![0.0; n];
            rhs[n - 1] = boundary;
            let mut answer = vec![0.0; n];
            let info = direct.solve(&rhs, &mut answer).unwrap();
            assert!(info.rel_residual < 1e-12);
            for (i, value) in answer.iter().enumerate() {
                let exact = boundary * (i + 1) as f64 / (n + 1) as f64;
                assert!((value - exact).abs() < 1e-11, "threads{threads}, n{n}, node{i}: {value} vs {exact}");
            }
            assert_eq!(faer::get_global_parallelism(), ambient);
        }
    }
}

#[test]
fn direct_factors_own_their_storage_and_never_change_process_parallelism() {
    for threads in [1, 4] {
        direct_harmonic_profile(threads);
    }
    // Independent Engines/Direct users may solve concurrently with different pool sizes.
    let barrier = std::sync::Barrier::new(2);
    Pool::new(2).install(|| {
        femlab_engine::par::map_collect(2, |index| {
            barrier.wait();
            direct_harmonic_profile([1, 4][index]);
        })
    });
}

// ------------------------------------------------------- simplex mass regression (#131)
const SIMPLEX_KINDS: [ElementKind; 4] = [ElementKind::Tri3, ElementKind::Tri6, ElementKind::Tet4, ElementKind::Tet10];
type BaryPoly = Vec<(f64, [i32; 4])>;

fn bary_product(a: &[(f64, [i32; 4])], b: &[(f64, [i32; 4])]) -> BaryPoly {
    a.iter()
        .flat_map(|(ca, ea)| b.iter().map(move |(cb, eb)| (*ca * cb, std::array::from_fn(|i| ea[i] + eb[i]))))
        .collect()
}

/// Dirichlet's closed form: integral of barycentric powers is product(a_i!)/(d+sum(a_i))!.
/// No quadrature points, Jacobians, or production shape evaluations enter this oracle.
fn bary_integral(p: &[(f64, [i32; 4])], dim: usize) -> f64 {
    p.iter()
        .map(|(c, e)| {
            c * e.iter().map(|&a| factorial(a)).product::<f64>() / factorial(dim as i32 + e.iter().sum::<i32>())
        })
        .sum()
}

fn bary_power(coefficient: f64, coordinate: usize, power: i32) -> (f64, [i32; 4]) {
    let mut e = [0; 4];
    e[coordinate] = power;
    (coefficient, e)
}

fn bary_shapes(kind: ElementKind) -> Vec<BaryPoly> {
    let corners = kind.dim() + 1;
    let quadratic = kind.n_nodes() > corners;
    let mut shapes: Vec<BaryPoly> =
        (0..corners)
            .map(|i| {
                if quadratic {
                    vec![bary_power(2.0, i, 2), bary_power(-1.0, i, 1)]
                } else {
                    vec![bary_power(1.0, i, 1)]
                }
            })
            .collect();
    if quadratic {
        for &[a, b] in kind.edges() {
            shapes.push(bary_product(&[bary_power(4.0, a as usize, 1)], &[bary_power(1.0, b as usize, 1)]));
        }
    }
    shapes
}

#[test]
fn simplex_product_quadrature_integrates_the_required_polynomial_degrees() {
    use femlab_engine::fem::shape::product_rule_of;
    for (kind, degree, exact) in [
        (ElementKind::Tri3, 3, exact_tri as Exact),
        (ElementKind::Tri6, 8, exact_tri as Exact),
        (ElementKind::Tet4, 2, exact_tet as Exact),
        (ElementKind::Tet10, 7, exact_tet as Exact),
    ] {
        let r = product_rule_of(kind);
        check_exact(&r, kind.dim(), 0, degree, exact);
        assert!(r.weights.iter().all(|&w| w > 0.0));
        assert!(r.points.iter().all(in_simplex));
    }
}

#[test]
fn every_simplex_mass_and_capacity_entry_matches_barycentric_closed_forms() {
    let mat = conductor(1.0, 2.3, 4.7);
    for kind in SIMPLEX_KINDS {
        let dim = kind.dim();
        let nn = kind.n_nodes();
        let nd = nn * dim;
        let shapes = bary_shapes(kind);
        // The separable quadratic map has exactly known diagonal Jacobian factors.
        for curvature in [0.0, 0.2] {
            if curvature > 0.0 && nn == dim + 1 {
                continue;
            }
            let coords: Vec<f64> = node_xi(kind)
                .iter()
                .flat_map(|p| {
                    [
                        1.0 + 2.0 * p[0] + curvature * p[0] * p[0],
                        2.0 * p[1] + curvature * p[1] * p[1],
                        3.0 * p[2] + curvature * p[2] * p[2],
                    ]
                })
                .collect();
            let mut jac = vec![(1.0, [0; 4])];
            for axis in 0..dim {
                let slope = [2.0, 2.0, 3.0][axis];
                jac = bary_product(&jac, &[(slope, [0; 4]), bary_power(2.0 * curvature, axis + 1, 1)]);
            }
            for id in idealisations(kind) {
                let scale = match id {
                    Idealisation::Axisymmetric => {
                        vec![(2.0 * PI, [0; 4]), bary_power(4.0 * PI, 1, 1), bary_power(2.0 * PI * curvature, 1, 2)]
                    }
                    Idealisation::PlaneStress { thickness } => vec![(thickness, [0; 4])],
                    _ => vec![(1.0, [0; 4])],
                };
                let weight = bary_product(&jac, &scale);
                let volume = bary_integral(&weight, dim);
                let c = ctx(&coords, &mat, id.clone(), Formulation::Full);
                let mut m = vec![0.0; nd * nd];
                let mut capacity = vec![0.0; nn * nn];
                element_for(kind).mass(&c, &mut m, false).expect("valid simplex");
                femlab_engine::fem::heat::capacity(kind, &c, &mut capacity).expect("valid simplex");
                let mut scalar = vec![0.0; nn * nn];
                for a in 0..nn {
                    for b in 0..nn {
                        let want =
                            mat.rho * bary_integral(&bary_product(&bary_product(&shapes[a], &shapes[b]), &weight), dim);
                        scalar[a * nn + b] = m[(a * dim) * nd + b * dim];
                        assert!(
                            (capacity[a * nn + b] - mat.cp * want).abs() < 2e-12 * mat.rho * mat.cp * volume,
                            "{kind:?} {id:?} curvature={curvature} C[{a},{b}]"
                        );
                        for i in 0..dim {
                            for j in 0..dim {
                                let expected = if i == j { want } else { 0.0 };
                                assert!(
                                    (m[(a * dim + i) * nd + b * dim + j] - expected).abs() < 2e-12 * mat.rho * volume,
                                    "{kind:?} {id:?} curvature={curvature} M[{a},{b}]"
                                );
                            }
                        }
                    }
                }
                // Every Cholesky pivot is positive: this detects the old rank-deficient rules.
                for a in 0..nn {
                    for b in 0..=a {
                        let pivot =
                            scalar[a * nn + b] - (0..b).map(|k| scalar[a * nn + k] * scalar[b * nn + k]).sum::<f64>();
                        scalar[a * nn + b] = if a == b {
                            assert!(pivot > 1e-8 * mat.rho * volume, "{kind:?} pivot {a} = {pivot}");
                            pivot.sqrt()
                        } else {
                            pivot / scalar[b * nn + b]
                        };
                    }
                }
                let diagonal: Vec<f64> = (0..nn).map(|a| m[(a * dim) * nd + a * dim]).collect();
                let trace = diagonal.iter().sum::<f64>();
                element_for(kind).mass(&c, &mut m, true).expect("HRZ lumping");
                for i in 0..nd {
                    let want = diagonal[i / dim] * mat.rho * volume / trace;
                    assert!(m[i * nd + i] > 0.0);
                    assert!((m[i * nd + i] - want).abs() < 2e-12 * mat.rho * volume);
                    for j in 0..nd {
                        assert!(i == j || m[i * nd + j] == 0.0);
                    }
                }
            }
        }
    }
}

#[test]
fn simplex_axial_modes_converge_to_the_closed_form_bar_frequency() {
    for kind in SIMPLEX_KINDS {
        let mut errors = Vec::new();
        for n in [4, 8, 16] {
            let mesh = Structured { kind, n: [n, 1, 1] }.box_([1.0, 0.01, 0.01]);
            let mut sets = sets_of(&mesh);
            sets.insert(
                "all".into(),
                ResolvedSet {
                    kind: SetKind::Node,
                    nodes: (0..mesh.n_nodes() as u32).collect(),
                    elems: Vec::new(),
                    faces: Vec::new(),
                },
            );
            let bodies = one_body();
            let id = if kind.dim() == 3 { Idealisation::Solid3d } else { Idealisation::PlaneStrain };
            let mut p = problem(
                &mesh,
                &sets,
                &bodies,
                id,
                Formulation::Full,
                vec![
                    fix("root", "xmin", [true, false, false], 0.0),
                    fix("transverse", "all", [false, true, kind.dim() == 3], 0.0),
                ],
            );
            p.materials[0].props = vec![1.0, 0.0];
            p.materials[0].rho = 1.0;
            let res = run_step(&p, &Step::Modal { n_modes: 1, shift: None, solver: SolveOptions::default() })
                .expect("axial bar mode");
            // u=sin(pi*x/2), E=rho=L=1 => f=1/4 Hz.
            errors.push((res.frequencies[0] / 0.25 - 1.0).abs());
        }
        let rate = observed_rate(&[0.25, 0.125, 0.0625], &errors);
        let required = if kind.n_nodes() == kind.dim() + 1 { 1.9 } else { 3.8 };

        assert!(rate > required, "{kind:?} modal rate {rate}: {errors:?}");
        assert!(errors[2] < 0.001, "{kind:?}: {errors:?}");
    }
}

#[test]
fn simplex_transient_capacity_converges_to_the_forced_slab_fourier_solution() {
    let end = 0.1;
    // T=x(1-x)/2 - sum_{m odd} 4 sin(m*pi*x) exp(-m²*pi²*t)/(m*pi)³.
    let exact = 1.0 / 12.0
        - (0..40)
            .map(|j| {
                let m = (2 * j + 1) as f64;
                8.0 / (m * PI).powi(4) * libm::exp(-(m * PI).powi(2) * end)
            })
            .sum::<f64>();
    for kind in SIMPLEX_KINDS {
        let mut errors = Vec::new();
        for n in [4, 8, 16] {
            let mesh = Structured { kind, n: [n, 1, 1] }.box_([1.0, 0.01, 0.01]);
            let sets = sets_of(&mesh);
            let bodies = one_body();
            let id = if kind.dim() == 3 { Idealisation::Solid3d } else { Idealisation::PlaneStrain };
            let p = heat_problem(
                &mesh,
                &sets,
                &bodies,
                id,
                conductor(1.0, 1.0, 1.0),
                vec![hold("cold", "xmin", 0.0), hold("cold2", "xmax", 0.0)],
                vec![HeatLoad::Source { bodies: bodies.clone(), q: 1.0 }],
            );
            let step = Step::HeatTransient {
                dt: 0.00001,
                t_end: end,
                theta: 0.5,
                initial: 0.0,
                output_every: 10000,
                amplitude: None,
                solver: SolveOptions::default(),
                control: NonlinearControl::default(),
            };
            let res = run_step(&p, &step).expect("heated slab");
            // Every structured simplex has equal volume. Integrate T_h using exact
            // barycentric moments, independently of the capacity matrix under test.
            let temperature = temperature_of(&res);
            let moments: Vec<f64> = bary_shapes(kind)
                .iter()
                .map(|shape| bary_integral(shape, kind.dim()) * factorial(kind.dim() as i32))
                .collect();
            let mut mean = 0.0;
            for elem in 0..mesh.n_elems() {
                for (&node, &moment) in mesh.elem_nodes(elem as u32).iter().zip(&moments) {
                    mean += temperature[node as usize] * moment / mesh.n_elems() as f64;
                }
            }
            errors.push((mean - exact).abs());
        }
        let rate = observed_rate(&[0.25, 0.125, 0.0625], &errors);
        let required = if kind.n_nodes() == kind.dim() + 1 { 1.8 } else { 3.5 };

        assert!(errors.windows(2).all(|pair| pair[1] < pair[0]), "{kind:?}: {errors:?}");
        assert!(rate > required, "{kind:?} transient rate {rate}: {errors:?}");
        assert!(errors[2] < 0.0002, "{kind:?}: {errors:?}");
    }
}

/// Every structural family must share one acceleration under uniform gravity, even where
/// consistent higher-order nodal gravity has negative/zero entries while HRZ masses are positive.
/// Pappus gives the axisymmetric annulus mass; its axial translation is also a rigid mode.
#[test]
fn explicit_gravity_uses_its_lumped_inertia_for_all_kinds_and_idealisations() {
    let velocity = [0.0, 0.2, 0.0];
    let gravity = [0.0, -9.81, 0.0];
    for kind in ALL_KINDS {
        for id in idealisations(kind) {
            for nx in [1, 2, 4] {
                let mut mesh = Structured { kind, n: [nx, 1, 1] }.box_([1.0, 0.1, 0.1]);
                // r spans [1,2], away from the axis, with centroid radius 1.5.
                for x in mesh.coords.iter_mut().step_by(3) {
                    *x += 1.0;
                }
                let sets = sets_of(&mesh);
                let bodies = one_body();
                let mut p = problem(&mesh, &sets, &bodies, id.clone(), Formulation::Full, Vec::new());
                p.loads = vec![Load::Gravity { g: [0.0, -4.0, 0.0] }, Load::Gravity { g: [0.0, -5.81, 0.0] }];
                let dpn = p.dofs_per_node();
                let base = if kind.dim() == 3 { 0.01 } else { 0.1 };
                let total_mass = DENSITY * weighted(&id, base, 1.5);
                // The unchanged consistent path still conserves total gravity. Quadratic
                // nodal distribution must remain consistent for static/modal calculations.
                let mut consistent = vec![0.0; mesh.n_nodes() * dpn];
                let totals = assemble_loads(&p, &mut consistent).unwrap();
                assert!((totals.force[1] - total_mass * gravity[1]).abs() < 1e-11 * total_mass);
                for factor in [0.5, 0.9] {
                    for ratio in [0.25, 6.25] {
                        let end = ratio * factor * critical_step(&p);
                        let step = Step::Explicit {
                            t_end: end,
                            dt_factor: factor,
                            initial_velocity: Some(velocity[..dpn].repeat(mesh.n_nodes())),
                            output_every: 2,
                        };
                        let mut previous = None;
                        for threads in [1, 4] {
                            let mut progress = |_: Progress| true;
                            let pool = Pool::new(threads);
                            let res = pollster::block_on(procedure::run(&p, &step, &pool, None, None, &mut progress))
                                .unwrap();
                            let history = res.history.unwrap();
                            assert_eq!(*history.times.last().unwrap(), end);
                            for (&time, field) in history.times.iter().zip(&history.values) {
                                for (i, value) in field.iter().enumerate() {
                                    let c = i % dpn;
                                    let expected = velocity[c] * time + 0.5 * gravity[c] * time * time;
                                    assert!(
                                        (value - expected).abs() < 1e-10 * end,
                                        "{kind:?} {id:?} nx{nx} factor{factor} t{time}: {value} vs {expected}"
                                    );
                                }
                            }
                            // The integrator reports half-step velocity at t+dt/2. Its total
                            // momentum increment is the impulse of the independently known weight.
                            let expected_momentum =
                                total_mass * (velocity[1] + gravity[1] * (end + 0.5 * res.scalars["dt"]));
                            assert!((res.scalars["momentum_y"] - expected_momentum).abs() < 1e-10 * total_mass);
                            if let Some(previous) = previous {
                                assert_eq!(history, previous);
                            }
                            previous = Some(history);
                        }
                    }
                }
            }
        }
    }
}

/// A single affine quad8's consistent gravity has negative corner loads (-rho*A*g/12)
/// and positive midside loads (rho*A*g/3). Explicit uses HRZ, but the general static/modal
/// load assembler must keep these exact shape-function integrals.
#[test]
fn consistent_quadratic_gravity_distribution_remains_unchanged() {
    let mesh = Structured { kind: ElementKind::Quad8, n: [1, 1, 1] }.box_([1.0, 1.0, 0.0]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let mut p =
        problem(&mesh, &sets, &bodies, Idealisation::PlaneStress { thickness: 0.5 }, Formulation::Full, Vec::new());
    p.loads = vec![Load::Gravity { g: [0.0, -12.0, 0.0] }];
    let mut f = vec![0.0; 2 * mesh.n_nodes()];
    let totals = assemble_loads(&p, &mut f).unwrap();
    let weight = -12.0 * DENSITY * 0.5;
    assert!((totals.force[1] - weight).abs() < 1e-10);
    for i in 0..mesh.n_nodes() {
        let [x, y, _] = mesh.node(i as u32);
        let corner = (x == 0.0 || x == 1.0) && (y == 0.0 || y == 1.0);
        let expected = if corner { -weight / 12.0 } else { weight / 3.0 };
        assert!((f[2 * i + 1] - expected).abs() < 1e-10);
        assert_eq!(f[2 * i], 0.0);
    }
}

// ---------------------------------------------------------------- section library

fn mm(v: f64) -> Q<Length> {
    Q::new(v, "mm")
}

fn props(spec: SectionSpec) -> Section {
    properties(&spec).expect("a valid section")
}

fn spec_error(spec: SectionSpec) -> Error {
    properties(&spec).expect_err("an invalid section")
}

/// Every closed form of the library against an oracle written from the geometry, and the
/// I-section against the IPE 200 datasheet (Benchmark B20).
#[test]
fn section_properties_match_their_closed_forms_and_a_datasheet() {
    // Rectangle 60 x 100 mm: A = bh, I_y = bh^3/12 about the width axis, I_z = hb^3/12.
    let (b, h) = (0.060, 0.100);
    let r = props(SectionSpec::Rectangle { width: mm(60.0), height: mm(100.0) });
    assert!((r.a - b * h).abs() < 1e-18, "{r:?}");
    assert!((r.i_y - b * h * h * h / 12.0).abs() < 1e-18, "{r:?}");
    assert!((r.i_z - h * b * b * b / 12.0).abs() < 1e-18, "{r:?}");
    assert_eq!((r.c_y, r.c_z), (0.5 * b, 0.5 * h));
    assert_eq!((r.k_y, r.k_z), (5.0 / 6.0, 5.0 / 6.0));
    // Roark's rectangle torsion constant is 0.1406 s^4 for a square, whichever side is longer.
    let square = props(SectionSpec::Rectangle { width: mm(50.0), height: mm(50.0) });
    // Roark fits 0.14083 where the exact Saint-Venant series gives 0.140577.
    assert!((square.j / 0.050f64.powi(4) - 0.1406).abs() < 3e-4, "{}", square.j);
    let tall = props(SectionSpec::Rectangle { width: mm(100.0), height: mm(60.0) });
    assert!((tall.j - r.j).abs() < 1e-18, "the torsion constant does not depend on which side is which");

    // Circle: A = pi r^2, I = pi r^4 / 4 both ways, J = 2I (the polar moment).
    let rad = 0.025;
    let c = props(SectionSpec::Circle { radius: mm(25.0) });
    assert!((c.a - PI * rad * rad).abs() < 1e-18, "{c:?}");
    assert!((c.i_y - PI * rad.powi(4) / 4.0).abs() < 1e-20, "{c:?}");
    assert_eq!((c.i_y, c.j), (c.i_z, 2.0 * c.i_y));
    assert_eq!((c.c_y, c.c_z, c.k_y, c.k_z), (rad, rad, 0.9, 0.9));

    // Tube 50 mm outside diameter, 5 mm wall: the solid circle minus the bore.
    let t = props(SectionSpec::Tube { radius: mm(25.0), thickness: mm(5.0) });
    let bore = 0.020;
    assert!((t.a - PI * (rad * rad - bore * bore)).abs() < 1e-18, "{t:?}");
    assert!((t.i_y - PI * (rad.powi(4) - bore.powi(4)) / 4.0).abs() < 1e-20, "{t:?}");
    assert_eq!((t.j, t.k_y, t.k_z), (2.0 * t.i_y, 0.5, 0.5));

    // IPE 200: h = 200, b = 100, t_w = 5.6, t_f = 8.5 mm. The datasheet gives
    // A = 2850 mm^2, I_y = 19.43e6 mm^4, I_z = 1.424e6 mm^4. The library models square
    // corners and the real profile has root fillets, so it lands just below on all three.
    let i = props(SectionSpec::I {
        height: mm(200.0),
        width: mm(100.0),
        web_thickness: mm(5.6),
        flange_thickness: mm(8.5),
    });
    let (hw, tw, tf, bf) = (0.200 - 2.0 * 0.0085, 0.0056, 0.0085, 0.100);
    assert!((i.a - (2.0 * bf * tf + hw * tw)).abs() < 1e-18, "{i:?}");
    // The fillets only ever add material, so a square-cornered model must land below the
    // datasheet on all three, and by no more than the fillets are worth.
    for (got, book, what) in [(i.a, 2850e-6, "A"), (i.i_y, 19.43e-6, "I_y"), (i.i_z, 1.424e-6, "I_z")] {
        let short = 1.0 - got / book;
        assert!((0.0..0.06).contains(&short), "{what} = {got} is {:.2} % off the IPE 200 datasheet", 100.0 * short);
    }
    // The oracle: two flange rectangles about the section's own axis, plus the web.
    let i_y_oracle = 2.0 * (bf * tf.powi(3) / 12.0 + bf * tf * (0.5 * (0.200 - tf)).powi(2)) + tw * hw.powi(3) / 12.0;
    assert!((i.i_y / i_y_oracle - 1.0).abs() < 1e-12, "{} vs {i_y_oracle}", i.i_y);
    assert!((i.i_z - (2.0 * tf * bf.powi(3) + hw * tw.powi(3)) / 12.0).abs() < 1e-20, "{i:?}");
    assert!((i.j - (2.0 * bf * tf.powi(3) + hw * tw.powi(3)) / 3.0).abs() < 1e-20, "{i:?}");
    assert!((i.k_z - hw * tw / i.a).abs() < 1e-12 && (i.k_y - 2.0 * bf * tf / i.a).abs() < 1e-12, "{i:?}");
    assert_eq!((i.c_y, i.c_z), (0.050, 0.100));

    // Channel 200 x 75 mm: the centroid moves off the web, and c_y is the far side of it.
    let ch = props(SectionSpec::Channel {
        height: mm(200.0),
        width: mm(75.0),
        web_thickness: mm(8.0),
        flange_thickness: mm(12.0),
    });
    let (h, bw, tw, tf) = (0.200, 0.075 - 0.008, 0.008, 0.012);
    let (a_web, a_fl) = (h * tw, 2.0 * bw * tf);
    assert!((ch.a - (a_web + a_fl)).abs() < 1e-18, "{ch:?}");
    let y_bar = (a_web * 0.5 * tw + a_fl * (tw + 0.5 * bw)) / ch.a;
    // The first moment about the centroid vanishes: the independent check on y_bar.
    let first = a_web * (0.5 * tw - y_bar) + a_fl * (tw + 0.5 * bw - y_bar);
    assert!(first.abs() < 1e-18, "{first}");
    assert!(ch.c_y > 0.5 * 0.075, "an unsymmetric channel's far fibre is past the middle: {}", ch.c_y);
    assert!((ch.c_y - (0.075 - y_bar)).abs() < 1e-15, "{ch:?}");
    assert_eq!(ch.c_z, 0.5 * h);
    assert!(
        (ch.i_z
            - (h * tw.powi(3) / 12.0
                + a_web * (0.5 * tw - y_bar).powi(2)
                + 2.0 * (tf * bw.powi(3) / 12.0 + bw * tf * (tw + 0.5 * bw - y_bar).powi(2))))
        .abs()
            < 1e-20,
        "{ch:?}"
    );
    assert!(
        (ch.i_y - (tw * h.powi(3) / 12.0 + 2.0 * (bw * tf.powi(3) / 12.0 + bw * tf * (0.5 * (h - tf)).powi(2)))).abs()
            < 1e-20,
        "{ch:?}"
    );
    assert!((ch.j - (h * tw.powi(3) + 2.0 * bw * tf.powi(3)) / 3.0).abs() < 1e-20, "{ch:?}");
    assert!((ch.k_y - a_fl / ch.a).abs() < 1e-12 && (ch.k_z - a_web / ch.a).abs() < 1e-12, "{ch:?}");

    // Generic: the numbers pass through untouched, with the documented defaults.
    let g = props(SectionSpec::Generic {
        a: Q::new(2850.0, "mm^2"),
        i_y: Q::new(19.43e6, "mm^4"),
        i_z: Q::new(1.424e6, "mm^4"),
        j: Q::new(6.98e4, "mm^4"),
        k_y: None,
        k_z: None,
        c_y: None,
        c_z: None,
    });
    assert!((g.a - 2850e-6).abs() < 1e-18 && (g.i_y - 19.43e-6).abs() < 1e-20, "{g:?}");
    assert_eq!((g.k_y, g.k_z, g.c_y, g.c_z), (5.0 / 6.0, 5.0 / 6.0, 0.0, 0.0));
    let g = props(SectionSpec::Generic {
        a: Q::new(1.0, "m^2"),
        i_y: Q::new(2.0, "m^4"),
        i_z: Q::new(3.0, "m^4"),
        j: Q::new(4.0, "m^4"),
        k_y: Some(0.4),
        k_z: Some(1.0),
        c_y: Some(mm(30.0)),
        c_z: Some(mm(0.0)),
    });
    assert_eq!((g.k_y, g.k_z, g.c_y, g.c_z), (0.4, 1.0, 0.030, 0.0));
}

#[test]
fn a_section_that_cannot_exist_is_a_located_schema_error() {
    // Every dimension of every shape is checked where it is named, so a zero in any one of
    // them says which one.
    let zero = mm(0.0);
    let cases: [(SectionSpec, &str, &str); 22] = [
        (SectionSpec::Tube { radius: zero.clone(), thickness: mm(1.0) }, "shape.radius", "must be positive"),
        (SectionSpec::Tube { radius: mm(10.0), thickness: zero.clone() }, "shape.thickness", "must be positive"),
        (
            SectionSpec::I { height: zero.clone(), width: mm(10.0), web_thickness: mm(1.0), flange_thickness: mm(1.0) },
            "shape.height",
            "must be positive",
        ),
        (
            SectionSpec::I { height: mm(20.0), width: zero.clone(), web_thickness: mm(1.0), flange_thickness: mm(1.0) },
            "shape.width",
            "must be positive",
        ),
        (
            SectionSpec::I {
                height: mm(20.0),
                width: mm(10.0),
                web_thickness: zero.clone(),
                flange_thickness: mm(1.0),
            },
            "shape.webThickness",
            "must be positive",
        ),
        (
            SectionSpec::I {
                height: mm(20.0),
                width: mm(10.0),
                web_thickness: mm(1.0),
                flange_thickness: zero.clone(),
            },
            "shape.flangeThickness",
            "must be positive",
        ),
        (
            SectionSpec::Channel {
                height: zero.clone(),
                width: mm(10.0),
                web_thickness: mm(1.0),
                flange_thickness: mm(1.0),
            },
            "shape.height",
            "must be positive",
        ),
        (
            SectionSpec::Channel {
                height: mm(20.0),
                width: zero.clone(),
                web_thickness: mm(1.0),
                flange_thickness: mm(1.0),
            },
            "shape.width",
            "must be positive",
        ),
        (
            SectionSpec::Channel {
                height: mm(20.0),
                width: mm(10.0),
                web_thickness: zero.clone(),
                flange_thickness: mm(1.0),
            },
            "shape.webThickness",
            "must be positive",
        ),
        (
            SectionSpec::Channel { height: mm(20.0), width: mm(10.0), web_thickness: mm(1.0), flange_thickness: zero },
            "shape.flangeThickness",
            "must be positive",
        ),
        (SectionSpec::Rectangle { width: mm(0.0), height: mm(1.0) }, "shape.width", "must be positive"),
        (SectionSpec::Rectangle { width: mm(1.0), height: mm(-1.0) }, "shape.height", "must be positive"),
        (SectionSpec::Circle { radius: Q::new(1.0, "kg") }, "shape.radius", "expected a length"),
        (SectionSpec::Tube { radius: mm(10.0), thickness: mm(10.0) }, "shape.radius - thickness", "must be positive"),
        (
            SectionSpec::I { height: mm(20.0), width: mm(10.0), web_thickness: mm(1.0), flange_thickness: mm(10.0) },
            "shape.height - 2 flangeThickness",
            "must be positive",
        ),
        (
            SectionSpec::I { height: mm(20.0), width: mm(10.0), web_thickness: mm(1000.0), flange_thickness: mm(1.0) },
            "shape.width - webThickness",
            "must be positive",
        ),
        (
            SectionSpec::Channel {
                height: mm(20.0),
                width: mm(10.0),
                web_thickness: mm(1.0),
                flange_thickness: mm(1000.0),
            },
            "shape.height - 2 flangeThickness",
            "must be positive",
        ),
        (
            SectionSpec::Channel {
                height: mm(20.0),
                width: mm(10.0),
                web_thickness: mm(1000.0),
                flange_thickness: mm(1.0),
            },
            "shape.width - webThickness",
            "must be positive",
        ),
        (generic_with(0.0, 1.0, 1.0, 1.0, None, None), "shape.a", "must be positive"),
        (generic_with(1.0, 0.0, 1.0, 1.0, None, None), "shape.iY", "must be positive"),
        (generic_with(1.0, 1.0, -1.0, 1.0, None, None), "shape.iZ", "must be positive"),
        (generic_with(1.0, 1.0, 1.0, 0.0, None, None), "shape.j", "must be positive"),
    ];
    for (spec, where_, cause) in cases {
        let e = spec_error(spec);
        assert_eq!(e.where_.as_deref(), Some(where_));
        assert!(e.cause.contains(cause), "{where_}: {}", e.cause);
    }
    for (k, where_) in [(Some(0.0), "shape.kY"), (Some(1.5), "shape.kZ")] {
        let spec = if where_ == "shape.kY" {
            generic_with(1.0, 1.0, 1.0, 1.0, k, None)
        } else {
            generic_with(1.0, 1.0, 1.0, 1.0, None, k)
        };
        let e = spec_error(spec);
        assert_eq!(e.where_.as_deref(), Some(where_));
        assert!(e.cause.contains("must be in (0, 1]"), "{}", e.cause);
    }
    // A negative extreme fibre is a wrong section; a bad unit on one is a dimension error.
    let mut spec = generic_with(1.0, 1.0, 1.0, 1.0, None, None);
    if let SectionSpec::Generic { c_y, c_z, .. } = &mut spec {
        *c_y = Some(mm(-1.0));
        *c_z = Some(Q::new(1.0, "s"));
    }
    let e = spec_error(spec.clone());
    assert_eq!(e.where_.as_deref(), Some("shape.cY"));
    assert!(e.cause.contains("zero or positive"), "{}", e.cause);
    if let SectionSpec::Generic { c_y, .. } = &mut spec {
        *c_y = None;
    }
    assert_eq!(spec_error(spec).where_.as_deref(), Some("shape.cZ"));
    // A wrong dimension on the area and the moments is located too.
    for (field, at) in [(0usize, "shape.a"), (1, "shape.iY"), (2, "shape.iZ"), (3, "shape.j")] {
        let mut spec = generic_with(1.0, 1.0, 1.0, 1.0, None, None);
        if let SectionSpec::Generic { a, i_y, i_z, j, .. } = &mut spec {
            let wrong = "s";
            match field {
                0 => *a = Q::new(1.0, wrong),
                1 => *i_y = Q::new(1.0, wrong),
                2 => *i_z = Q::new(1.0, wrong),
                _ => *j = Q::new(1.0, wrong),
            }
        }
        assert_eq!(spec_error(spec).where_.as_deref(), Some(at));
    }
}

fn generic_with(a: f64, i_y: f64, i_z: f64, j: f64, k_y: Option<f64>, k_z: Option<f64>) -> SectionSpec {
    SectionSpec::Generic {
        a: Q::new(a, "m^2"),
        i_y: Q::new(i_y, "m^4"),
        i_z: Q::new(i_z, "m^4"),
        j: Q::new(j, "m^4"),
        k_y,
        k_z,
        c_y: None,
        c_z: None,
    }
}

// ---------------------------------------------------------------- the truss element

/// A member from the origin along an arbitrary skew direction, so nothing in the element can
/// quietly assume an axis-aligned bar.
const TRUSS_DIR: [f64; 3] = [2.0 / 3.0, -1.0 / 3.0, 2.0 / 3.0];
const TRUSS_LENGTH: f64 = 2.5;
const TRUSS_AREA: f64 = 0.004;

fn truss_coords() -> Vec<f64> {
    let mut c = vec![0.3, -0.2, 0.7, 0.0, 0.0, 0.0];
    for k in 0..3 {
        c[3 + k] = c[k] + TRUSS_LENGTH * TRUSS_DIR[k];
    }
    c
}

fn truss_section() -> Section {
    properties(&SectionSpec::Generic {
        a: Q::new(TRUSS_AREA, "m^2"),
        i_y: Q::new(1.0, "m^4"),
        i_z: Q::new(1.0, "m^4"),
        j: Q::new(1.0, "m^4"),
        k_y: None,
        k_z: None,
        c_y: None,
        c_z: None,
    })
    .expect("a valid generic section")
}

fn truss_ctx<'a>(
    coords: &'a [f64],
    mat: &'a Material,
    section: Option<&'a Section>,
    temperature: Option<&'a [f64]>,
) -> ElementCtx<'a> {
    ElementCtx {
        coords,
        material: mat,
        section,
        idealisation: Idealisation::Solid3d,
        formulation: Formulation::Full,
        temperature,
        t_ref: 0.0,
    }
}

/// `K = (EA/L) t tᵀ` with `t = [−e1, e1]`: symmetric, rank one, and driving one end by `δ`
/// along the axis takes exactly `EAδ/L` — which is Benchmark A5 for a bar, at element level.
#[test]
fn the_truss_stiffness_is_ea_over_l_along_its_own_axis_and_nothing_across_it() {
    let coords = truss_coords();
    let (mat, sec) = (steel(), truss_section());
    let c = truss_ctx(&coords, &mat, Some(&sec), None);
    let el = element_for(ElementKind::Truss2);
    assert_eq!((el.kind(), el.n_dof(), el.n_gp()), (ElementKind::Truss2, 6, 1));
    let mut k = vec![0.0; 36];
    let half = el.stiffness(&c, &mut k).expect("a straight member");
    assert!((half - 0.5 * TRUSS_LENGTH).abs() < 1e-15, "det J is L/2, got {half}");
    assert_eq!(half, min_det_j(ElementKind::Truss2, &coords).expect("the same Jacobian"));

    let ea_l = YOUNG * TRUSS_AREA / TRUSS_LENGTH;
    for i in 0..6 {
        for j in 0..6 {
            let (si, sj) = (if i < 3 { -1.0 } else { 1.0 }, if j < 3 { -1.0 } else { 1.0 });
            let want = ea_l * si * TRUSS_DIR[i % 3] * sj * TRUSS_DIR[j % 3];
            assert!((k[i * 6 + j] - want).abs() < 1e-6 * ea_l, "K[{i}][{j}] = {} want {want}", k[i * 6 + j]);
            assert!((k[i * 6 + j] - k[j * 6 + i]).abs() < 1e-9 * ea_l, "K is symmetric");
        }
    }
    // Five independent motions leave the member unstrained: three rigid translations and the
    // two transverse relative motions. Only stretching along the axis costs energy.
    let axial: Vec<f64> = (0..6).map(|i| if i < 3 { -TRUSS_DIR[i] } else { TRUSS_DIR[i - 3] }).collect();
    let transverse = [1.0, 2.0, 0.0];
    let mut free: Vec<Vec<f64>> =
        (0..3).map(|a| (0..6).map(|i| if i % 3 == a { 1.0 } else { 0.0 }).collect()).collect();
    // `transverse` is orthogonal to the axis, so moving one node along it does not stretch.
    assert!(transverse.iter().zip(TRUSS_DIR).map(|(a, b)| a * b).sum::<f64>().abs() < 1e-15);
    free.push((0..6).map(|i| if i < 3 { 0.0 } else { transverse[i - 3] }).collect());
    free.push((0..6).map(|i| if i < 3 { transverse[i] } else { 0.0 }).collect());
    for u in &free {
        let energy: f64 = (0..6).map(|i| u[i] * (0..6).map(|j| k[i * 6 + j] * u[j]).sum::<f64>()).sum();
        assert!(energy.abs() < 1e-6 * ea_l, "a strain-free motion costs no energy, got {energy}");
    }
    let energy: f64 = (0..6).map(|i| axial[i] * (0..6).map(|j| k[i * 6 + j] * axial[j]).sum::<f64>()).sum();
    assert!((energy - 4.0 * ea_l).abs() < 1e-6 * ea_l, "stretching by 2 costs 4 EA/L, got {energy}");

    // A5 for a bar: prescribe the far end by delta and read the force back as EA delta / L.
    let delta = 1e-4;
    let u: Vec<f64> = (0..6).map(|i| if i < 3 { 0.0 } else { delta * TRUSS_DIR[i - 3] }).collect();
    let f: Vec<f64> = (0..6).map(|i| (0..6).map(|j| k[i * 6 + j] * u[j]).sum()).collect();
    let magnitude = libm::sqrt(f[3] * f[3] + f[4] * f[4] + f[5] * f[5]);
    assert!((magnitude - ea_l * delta).abs() < 1e-6 * ea_l * delta, "{magnitude} vs {}", ea_l * delta);
    for i in 0..3 {
        assert!((f[i] + f[3 + i]).abs() < 1e-6 * ea_l * delta, "the two end forces balance");
    }

    // Strain and stress come back as the axial Voigt component alone.
    let (mut sig, mut eps) = (vec![0.0; VOIGT], vec![0.0; VOIGT]);
    el.recover(&c, &u, &mut sig, &mut eps).expect("recovery");
    assert!((eps[0] - delta / TRUSS_LENGTH).abs() < 1e-18, "{eps:?}");
    assert!((sig[0] - YOUNG * delta / TRUSS_LENGTH).abs() < 1e-3, "{sig:?}");
    assert!(sig[1..].iter().chain(eps[1..].iter()).all(|v| *v == 0.0), "only the axial component");
}

/// Consistent `ρAL/6 [[2I, I], [I, 2I]]`, lumped `ρAL/2` per direction, both conserving mass;
/// and `ω_max = (2/L)√(E/ρ)`, the exact largest frequency of the two-node bar.
#[test]
fn the_truss_mass_conserves_ral_and_its_frequency_bound_is_the_closed_form() {
    let coords = truss_coords();
    let (mat, sec) = (steel(), truss_section());
    let c = truss_ctx(&coords, &mat, Some(&sec), None);
    let el = element_for(ElementKind::Truss2);
    let total = DENSITY * TRUSS_AREA * TRUSS_LENGTH;
    let mut m = vec![0.0; 36];
    el.mass(&c, &mut m, false).expect("consistent mass");
    for a in 0..2 {
        for b in 0..2 {
            for i in 0..3 {
                let want = total / 6.0 * if a == b { 2.0 } else { 1.0 };
                assert!((m[(3 * a + i) * 6 + 3 * b + i] - want).abs() < 1e-15 * total, "{m:?}");
            }
        }
    }
    for i in 0..3 {
        let carried: f64 = (0..2).map(|a| (0..2).map(|b| m[(3 * a + i) * 6 + 3 * b + i]).sum::<f64>()).sum();
        assert!((carried - total).abs() < 1e-15 * total, "the consistent mass sums to rho A L");
    }
    let mut lumped = vec![0.0; 36];
    el.mass(&c, &mut lumped, true).expect("lumped mass");
    for i in 0..6 {
        assert!((lumped[i * 6 + i] - 0.5 * total).abs() < 1e-15 * total, "{lumped:?}");
    }
    assert!(lumped.iter().enumerate().all(|(at, v)| at % 7 == 0 || *v == 0.0), "lumped mass is diagonal");

    let want = 2.0 / TRUSS_LENGTH * libm::sqrt(YOUNG / DENSITY);
    let got = el.omega_max(&c).expect("a frequency bound");
    assert!((got / want - 1.0).abs() < 1e-12, "{got} vs {want}");

    // A weightless member has no mass matrix at all, and therefore no frequency bound.
    let massless = Material { rho: 0.0, ..steel() };
    let c0 = truss_ctx(&coords, &massless, Some(&sec), None);
    let mut zero = vec![1.0; 36];
    el.mass(&c0, &mut zero, false).expect("a zero mass matrix");
    assert!(zero.iter().all(|v| *v == 0.0));
    assert_eq!(el.omega_max(&c0).expect_err("no frequency").code, ErrorCode::ModelIllPosed);
    let bad = Material { rho: -1.0, ..steel() };
    let cb = truss_ctx(&coords, &bad, Some(&sec), None);
    assert_eq!(el.mass(&cb, &mut zero, false).expect_err("a negative density").code, ErrorCode::ModelIllPosed);
}

/// Gravity over a member is `ρ A L / 2` at each node; a uniform temperature rise on a member
/// held at both ends is `σ = −E α ΔT` (Benchmark B11 at element level).
#[test]
fn the_truss_body_and_thermal_loads_match_their_closed_forms() {
    let coords = truss_coords();
    let (mat, sec) = (steel(), truss_section());
    let el = element_for(ElementKind::Truss2);
    let c = truss_ctx(&coords, &mat, Some(&sec), None);
    let g = [0.0, 0.0, -9.81];
    let mut f = vec![0.0; 6];
    el.body_load(&c, &|_x| [DENSITY * g[0], DENSITY * g[1], DENSITY * g[2]], &mut f).expect("gravity");
    let weight = DENSITY * TRUSS_AREA * TRUSS_LENGTH * g[2];
    for node in 0..2 {
        assert!((f[3 * node + 2] - 0.5 * weight).abs() < 1e-12 * weight.abs(), "{f:?}");
        assert!(f[3 * node] == 0.0 && f[3 * node + 1] == 0.0, "{f:?}");
    }

    // With no temperature field the thermal load is exactly zero and needs no geometry.
    let mut th = vec![1.0; 6];
    el.thermal_load(&c, &mut th).expect("no temperature");
    assert!(th.iter().all(|v| *v == 0.0));

    let rise = 100.0;
    let t = [rise; 2];
    let hot = truss_ctx(&coords, &mat, Some(&sec), Some(&t));
    el.thermal_load(&hot, &mut th).expect("a temperature rise");
    let want = YOUNG * TRUSS_AREA * EXPANSION * rise;
    for i in 0..3 {
        assert!((th[i] + want * TRUSS_DIR[i]).abs() < 1e-9 * want, "{th:?}");
        assert!((th[3 + i] - want * TRUSS_DIR[i]).abs() < 1e-9 * want, "{th:?}");
    }
    // Held at both ends: zero displacement, so the stress is the fully restrained value.
    let (mut sig, mut eps) = (vec![0.0; VOIGT], vec![0.0; VOIGT]);
    el.recover(&hot, &[0.0; 6], &mut sig, &mut eps).expect("recovery");
    assert_eq!(eps[0], 0.0);
    assert!((sig[0] + YOUNG * EXPANSION * rise).abs() < 1e-6, "sigma = -E alpha dT, got {}", sig[0]);
}

/// The reference-element side: one Gauss point at the midpoint, linear shape functions, and a
/// point map that projects onto the member and stops at its ends.
#[test]
fn the_truss_maps_points_onto_its_own_axis_and_stops_at_its_ends() {
    let coords = truss_coords();
    let el = element_for(ElementKind::Truss2);
    assert_eq!(el.gp_xi(0), [0.0, 0.0, 0.0]);
    let mut n = [0.0; 2];
    el.shape_at([0.0, 0.0, 0.0], &mut n);
    assert_eq!(n, [0.5, 0.5]);
    el.shape_at([1.0, 0.0, 0.0], &mut n);
    assert_eq!(n, [0.0, 1.0]);

    let mid: Vec<f64> = (0..3).map(|k| 0.5 * (coords[k] + coords[3 + k])).collect();
    assert_eq!(el.inverse_map(&coords, [mid[0], mid[1], mid[2]]), Some([0.0, 0.0, 0.0]));
    let end = [coords[3], coords[4], coords[5]];
    let back = el.inverse_map(&coords, end).expect("the far end is on the member");
    assert!((back[0] - 1.0).abs() < 1e-12, "{back:?}");
    // Off the axis but abreast of the midpoint: a member is a curve, so a point beside it is
    // in no element rather than in whichever member happened to be checked first.
    let abreast = [mid[0] + 1.0, mid[1] + 2.0, mid[2]];
    assert_eq!(el.inverse_map(&coords, abreast), None);
    // A point on the axis a quarter of the way along is inside, and says where.
    let quarter: Vec<f64> = (0..3).map(|k| mid[k] + 0.25 * TRUSS_LENGTH * TRUSS_DIR[k]).collect();
    let xi = el.inverse_map(&coords, [quarter[0], quarter[1], quarter[2]]).expect("on the member");
    assert!((xi[0] - 0.5).abs() < 1e-12, "{xi:?}");
    // Past the end, it is outside.
    let past: Vec<f64> = (0..3).map(|k| coords[3 + k] + TRUSS_DIR[k]).collect();
    assert_eq!(el.inverse_map(&coords, [past[0], past[1], past[2]]), None);

    // A member with no length has no axis, which is exactly how a folded element is caught.
    for degenerate in [vec![0.0; 6], {
        let mut c = truss_coords();
        c[3] = f64::NAN;
        c
    }] {
        assert_eq!(el.inverse_map(&degenerate, [0.0; 3]), None);
        assert_eq!(min_det_j(ElementKind::Truss2, &degenerate), None);
        let (mat, sec) = (steel(), truss_section());
        let c = truss_ctx(&degenerate, &mat, Some(&sec), None);
        let t = [10.0; 2];
        let hot = truss_ctx(&degenerate, &mat, Some(&sec), Some(&t));
        let mut out = vec![0.0; 36];
        assert_eq!(el.stiffness(&c, &mut out).expect_err("no axis").code, ErrorCode::MeshInverted);
        assert_eq!(el.mass(&c, &mut out, false).expect_err("no axis").code, ErrorCode::MeshInverted);
        assert_eq!(
            el.recover(&c, &[0.0; 6], &mut out, &mut [0.0; VOIGT]).expect_err("x").code,
            ErrorCode::MeshInverted
        );
        assert_eq!(el.thermal_load(&hot, &mut out).expect_err("no axis").code, ErrorCode::MeshInverted);
        assert_eq!(
            el.body_load(&c, &|_x| [0.0, 0.0, -1.0], &mut out).expect_err("no axis").code,
            ErrorCode::MeshInverted
        );
    }
}

/// A member has no face and no cross-section geometry: both are structured errors that name
/// the Command that fixes them.
#[test]
fn a_truss_refuses_a_face_load_and_a_missing_section() {
    let coords = truss_coords();
    let mat = steel();
    let el = element_for(ElementKind::Truss2);
    let sec = truss_section();
    let c = truss_ctx(&coords, &mat, Some(&sec), None);
    let mut out = vec![0.0; 6];
    let e = el.face_load(&c, 0, FaceLoad::Pressure(1.0), &mut out).expect_err("no face");
    assert_eq!(e.code, ErrorCode::Unsupported);
    assert!(e.suggestion.as_deref().unwrap().contains("load.force"), "{e:?}");

    // nor a finite-strain kernel: static-nonlinear is written for continuum elements, and a
    // member says so rather than answering with its linear stiffness
    let (mut k, mut f) = (vec![0.0; 36], vec![0.0; 6]);
    let (mut sig, mut eps) = (vec![0.0; VOIGT], vec![0.0; VOIGT]);
    let mut state = Vec::new();
    let nl = TangentOut { k: &mut k, f: &mut f, stress: &mut sig, strain: &mut eps, state: &mut state };
    let e = el.tangent_and_force(&c, &[0.0; 6], &[], nl).expect_err("no finite-strain kernel");
    assert_eq!(e.code, ErrorCode::Unsupported);
    assert!(e.suggestion.as_deref().unwrap().contains("procedure 'static'"), "{e:?}");

    let bare = truss_ctx(&coords, &mat, None, None);
    let t = [10.0; 2];
    let bare_hot = truss_ctx(&coords, &mat, None, Some(&t));
    let mut big = vec![0.0; 36];
    for code in [
        el.stiffness(&bare, &mut big).expect_err("no section").code,
        el.mass(&bare, &mut big, false).expect_err("no section").code,
        el.body_load(&bare, &|_x| [0.0; 3], &mut big).expect_err("no section").code,
        el.thermal_load(&bare_hot, &mut big).expect_err("no section").code,
    ] {
        assert_eq!(code, ErrorCode::ModelNoSection);
    }
}

/// A member whose material law refuses its properties fails at every integral that calls the
/// law, and at none of the ones that do not.
#[test]
fn a_truss_reports_a_material_props_mismatch_from_every_integral_that_calls_the_law() {
    let coords = truss_coords();
    let sec = truss_section();
    let bad = Material { props: vec![YOUNG], ..steel() };
    let t = [30.0; 2];
    let c = truss_ctx(&coords, &bad, Some(&sec), Some(&t));
    let el = element_for(ElementKind::Truss2);
    let mut k = vec![0.0; 36];
    let mut v = vec![0.0; 6];
    let (mut sig, mut eps) = (vec![0.0; VOIGT], vec![0.0; VOIGT]);
    let fails = [
        el.stiffness(&c, &mut k).err(),
        el.thermal_load(&c, &mut v).err(),
        el.recover(&c, &[0.0; 6], &mut sig, &mut eps).err(),
        el.omega_max(&c).err(),
    ];
    for e in fails {
        let e = e.expect("a props mismatch must fail");
        assert_eq!(e.code, ErrorCode::MaterialProps);
        assert_eq!(e.where_.as_deref(), Some("material.props"));
    }
    // The geometry is fine: mass and a body load never call the law.
    assert!(el.mass(&c, &mut k, true).is_ok());
    assert!(el.body_load(&c, &|_x| [0.0; 3], &mut v).is_ok());
}

/// A line Body with no Section is refused before a solve starts, naming the Body.
#[test]
fn a_line_body_without_a_section_is_reported_by_the_well_posedness_checks() {
    let mesh = Mesh {
        dim: 3,
        coords: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        blocks: vec![femlab_geometry::ElementBlock { kind: ElementKind::Truss2, conn: vec![0, 1], first_elem: 0 }],
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::new(),
        face_sets: BTreeMap::new(),
    };
    let sets = BTreeMap::new();
    let bodies = vec!["chord".to_string()];
    let mut p = Problem {
        mesh: &mesh,
        sets: &sets,
        body_of_block: &bodies,
        material_of_block: vec![Some(0)],
        materials: vec![steel()],
        section_of_block: vec![None],
        sections: Vec::new(),
        idealisation: Idealisation::Solid3d,
        formulation: Formulation::Full,
        constraints: Vec::new(),
        loads: Vec::new(),
        temperature: None,
        heat: false,
        heat_loads: Vec::new(),
        couplings: Vec::new(),
        points: Vec::new(),
    };
    let errors = checks::all(&p);
    let missing = errors.iter().find(|e| e.code == ErrorCode::ModelNoSection).expect("model.no-section");
    assert!(missing.cause.contains("chord"), "{missing:?}");
    assert!(missing.suggestion.as_deref().unwrap().contains("section.assign"), "{missing:?}");

    // With a Section assigned the check is silent, and the member assembles.
    p.sections = vec![truss_section()];
    p.section_of_block = vec![Some(0)];
    assert!(!checks::all(&p).iter().any(|e| e.code == ErrorCode::ModelNoSection));
    let pat = pattern(&mesh, p.dofs_per_node());
    let a = assemble_stiffness(&p, &pat).expect("a truss assembles like any other block");
    assert_eq!(a.min_det_j, 0.5);
    assert!((a.k.diag()[0] - YOUNG * TRUSS_AREA / 1.0).abs() < 1e-3, "{:?}", a.k.diag());
}

/// Benchmark B12: the axial modes of a fixed-free bar meshed with truss elements converge to
/// `f_n = (2n-1)/(4L) sqrt(E/rho)` at the second order a linear element gives.
#[test]
fn truss_axial_modes_converge_to_the_closed_form_bar_frequency() {
    let mut errors = Vec::new();
    for n in [4u32, 8, 16] {
        let mesh = femlab_geometry::line(&[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]], &[[0, 1]], n, ElementKind::Truss2)
            .expect("a straight bar");
        let sets = BTreeMap::from([
            (
                "root".to_string(),
                ResolvedSet { kind: SetKind::Node, faces: Vec::new(), nodes: vec![0], elems: Vec::new() },
            ),
            (
                "all".to_string(),
                ResolvedSet {
                    kind: SetKind::Node,
                    faces: Vec::new(),
                    nodes: (0..mesh.n_nodes() as u32).collect(),
                    elems: Vec::new(),
                },
            ),
        ]);
        let bodies = vec!["bar".to_string()];
        let mut p = problem(
            &mesh,
            &sets,
            &bodies,
            Idealisation::Solid3d,
            Formulation::Full,
            vec![
                fix("root", "root", [true, false, false], 0.0),
                // A bar carries no transverse stiffness, so every node has to be held across
                // the axis or the model is a mechanism rather than a bar.
                fix("transverse", "all", [false, true, true], 0.0),
            ],
        );
        p.materials[0].props = vec![1.0, 0.0];
        p.materials[0].rho = 1.0;
        p.sections = vec![unit_section()];
        p.section_of_block = vec![Some(0)];
        let res = run_step(&p, &Step::Modal { n_modes: 3, shift: None, solver: SolveOptions::default() })
            .expect("axial bar modes");
        // E = rho = L = 1, so f_n = (2n - 1) / 4.
        for (i, f) in res.frequencies.iter().enumerate() {
            let exact = (2.0 * (i as f64 + 1.0) - 1.0) / 4.0;
            assert!(f / exact - 1.0 > -1e-12, "a discrete bar is stiffer than the continuum: {f} vs {exact}");
        }
        errors.push((res.frequencies[0] / 0.25 - 1.0).abs());
    }
    let rate = observed_rate(&[0.25, 0.125, 0.0625], &errors);
    assert!(rate > 1.9, "modal rate {rate}: {errors:?}");
    assert!(errors[2] < 0.01, "1 % at sixteen elements: {errors:?}");
}

/// A generic section of unit area, so `E = rho = A = L = 1` makes every closed form a round
/// number.
fn unit_section() -> Section {
    properties(&SectionSpec::Generic {
        a: Q::new(1.0, "m^2"),
        i_y: Q::new(1.0, "m^4"),
        i_z: Q::new(1.0, "m^4"),
        j: Q::new(1.0, "m^4"),
        k_y: None,
        k_z: None,
        c_y: None,
        c_z: None,
    })
    .expect("a valid generic section")
}

// ---------------------------------------------------------------- multipoint constraints

/// Two meshes as one, `b` translated by `shift` and sharing no node with `a`: the two-part
/// assembly only a tie holds together. `a`'s Sets take the prefix `a.` and `b`'s the prefix
/// `b.`, so `a.xmax` faces `b.xmin`.
fn join(a: &Mesh, b: &Mesh, shift: [f64; 3]) -> Mesh {
    let node_offset = a.n_nodes() as u32;
    let elem_offset = a.n_elems() as u32;
    let mut coords = a.coords.clone();
    for (i, x) in b.coords.iter().enumerate() {
        coords.push(x + shift[i % 3]);
    }
    let mut blocks = a.blocks.clone();
    for blk in &b.blocks {
        blocks.push(ElementBlock {
            kind: blk.kind,
            conn: blk.conn.iter().map(|n| n + node_offset).collect(),
            first_elem: blk.first_elem + elem_offset,
        });
    }
    let mut face_sets = BTreeMap::new();
    for (name, faces) in &a.face_sets {
        face_sets.insert(format!("a.{name}"), faces.clone());
    }
    for (name, faces) in &b.face_sets {
        let shifted = faces.iter().map(|f| Face { elem: f.elem + elem_offset, local: f.local }).collect();
        face_sets.insert(format!("b.{name}"), shifted);
    }
    Mesh { dim: a.dim, coords, blocks, node_sets: BTreeMap::new(), elem_sets: BTreeMap::new(), face_sets }
}

/// Two boxes of `size` meeting at `x = size[0] + gap`, meshed `na` and `nb` independently.
fn two_blocks(kind: ElementKind, na: [usize; 3], nb: [usize; 3], size: [f64; 3], gap: f64) -> Mesh {
    let a = Structured { kind, n: na }.box_(size);
    let b = Structured { kind, n: nb }.box_(size);
    join(&a, &b, [size[0] + gap, 0.0, 0.0])
}

fn two_bodies() -> Vec<String> {
    vec!["a".to_string(), "b".to_string()]
}

/// A bonded contact between two Sets.
fn tie(name: &str, master: &str, slave: &str, tol: f64) -> Coupling {
    Coupling::Bonded { name: name.into(), master: master.into(), slave: slave.into(), tol }
}

/// The bonded contact `a.xmax` → `b.xmin`, pairing within `tol`.
fn bond(tol: f64) -> Coupling {
    tie("weld", "a.xmax", "b.xmin", tol)
}

/// The index of the node at `x`, which the pairing assertions name by position.
fn node_at(mesh: &Mesh, x: [f64; 3]) -> u32 {
    (0..mesh.n_nodes() as u32)
        .find(|&n| {
            let p = mesh.node(n);
            (0..3).all(|k| (p[k] - x[k]).abs() < 1e-9)
        })
        .expect("the mesh has a node there")
}

/// A dense symmetric matrix as a `Csr` with every entry stored: the structure the dense oracle
/// multiplies, so the comparison is against the definition and not a sparse copy of it.
fn dense_csr(n: usize, a: &[f64]) -> Csr {
    Csr {
        n,
        row_ptr: (0..=n).map(|r| (r * n) as u32).collect(),
        col_idx: (0..n * n).map(|i| (i % n) as u32).collect(),
        vals: a.to_vec(),
    }
}

fn to_dense(k: &Csr) -> Vec<f64> {
    let mut out = vec![0.0; k.n * k.n];
    for r in 0..k.n {
        for e in k.row_ptr[r] as usize..k.row_ptr[r + 1] as usize {
            out[r * k.n + k.col_idx[e] as usize] = k.vals[e];
        }
    }
    out
}

/// `A B` for row-major `n × n` matrices.
fn mat_mul(a: &[f64], b: &[f64], n: usize) -> Vec<f64> {
    let mut out = vec![0.0; n * n];
    for i in 0..n {
        for j in 0..n {
            out[i * n + j] = (0..n).map(|k| a[i * n + k] * b[k * n + j]).sum();
        }
    }
    out
}

/// `Aᵀ B` for row-major `n × n` matrices.
fn mat_mul_t(a: &[f64], b: &[f64], n: usize) -> Vec<f64> {
    let mut out = vec![0.0; n * n];
    for i in 0..n {
        for j in 0..n {
            out[i * n + j] = (0..n).map(|k| a[k * n + i] * b[k * n + j]).sum();
        }
    }
    out
}

/// One `Mpc` built by hand, without a Mesh: the rows are the whole definition of `T`.
fn hand_mpc(rows: Vec<Row>) -> Mpc {
    let slaves = rows.iter().map(|r| r.slave).collect();
    Mpc { rows, slaves, contact: Vec::new(), warnings: Vec::new() }
}

/// The dense `T` of an `Mpc`: identity on the retained DOFs, the row's coefficients on a slave
/// row, and a zero column at every slave.
fn dense_t(mpc: &Mpc, n: usize) -> Vec<f64> {
    let mut t = vec![0.0; n * n];
    for (d, item) in t.iter_mut().step_by(n + 1).enumerate() {
        *item = if mpc.slaves.contains(&(d as u32)) { 0.0 } else { 1.0 };
    }
    for row in &mpc.rows {
        for &(m, a) in &row.masters {
            t[row.slave as usize * n + m as usize] = a;
        }
    }
    t
}

/// `transform` is `TᵀKT` and `Tᵀf`, checked against the dense definition on a hand-written
/// four-DOF system with two masters and a fractional split.
#[test]
fn transform_is_the_dense_t_transpose_k_t() {
    let n = 4;
    #[rustfmt::skip]
    let k = vec![
        4.0, -1.0,  0.5, -0.5,
       -1.0,  5.0, -2.0,  1.0,
        0.5, -2.0,  6.0, -1.5,
       -0.5,  1.0, -1.5,  7.0,
    ];
    let f = vec![1.0, -2.0, 3.0, 5.0];
    let mpc = hand_mpc(vec![Row { slave: 3, masters: vec![(0, 0.25), (1, 0.75)], owner: 0 }]);
    let t = dense_t(&mpc, n);
    let want = mat_mul_t(&t, &mat_mul(&k, &t, n), n);
    let (kt, ft) = mpc::transform(&dense_csr(n, &k), &f, &mpc);
    for (i, (g, w)) in to_dense(&kt).iter().zip(&want).enumerate() {
        assert!((g - w).abs() <= 1e-12, "entry {i}: got {g}, want {w}");
    }
    let want_f: Vec<f64> = (0..n).map(|r| (0..n).map(|i| t[i * n + r] * f[i]).sum()).collect();
    for (g, w) in ft.iter().zip(&want_f) {
        assert!((g - w).abs() <= 1e-12, "got {g}, want {w}");
    }
    assert_eq!(kt.row_ptr[3], kt.row_ptr[4], "the slave row is empty");
    assert_eq!(ft[3], 0.0);
    // Recovery is the same T: u = T v.
    let mut u = vec![2.0, -6.0, 1.0, 0.0];
    mpc::recover(&mpc, &mut u);
    assert!((u[3] - (0.25 * 2.0 + 0.75 * -6.0)).abs() <= 1e-15);
    // And the tie force a master carries is the slave residual times its coefficient.
    let mut tie_force = vec![0.0; n];
    mpc::master_forces(&mpc, &[0.0, 0.0, 0.0, 8.0], &mut tie_force);
    assert_eq!(tie_force, vec![2.0, 6.0, 0.0, 0.0]);
}

/// An empty `Mpc` is the identity: `transform` hands back the operator and the load unchanged,
/// which is what every model without a contact pays for the machinery.
#[test]
fn an_empty_mpc_transforms_nothing() {
    let none = Mpc::none();
    assert!(none.is_empty());
    assert!(none.pairs(3).is_empty());
    let k = dense_csr(2, &[2.0, -1.0, -1.0, 2.0]);
    let (kt, ft) = mpc::transform(&k, &[1.0, 2.0], &none);
    assert_eq!(kt, k);
    assert_eq!(ft, vec![1.0, 2.0]);
    let mut u = vec![7.0, 8.0];
    mpc::recover(&none, &mut u);
    assert_eq!(u, vec![7.0, 8.0]);
    // Node 0 tied to nodes 1 and 2 couples those node pairs, whatever the component.
    let mpc = hand_mpc(vec![
        Row { slave: 0, masters: vec![(3, 0.5), (6, 0.5)], owner: 0 },
        Row { slave: 1, masters: vec![(4, 0.5), (7, 0.5)], owner: 0 },
    ]);
    assert_eq!(mpc.pairs(3), vec![[0, 1], [0, 2]]);
}

proptest::proptest! {
    /// The transformed operator stays symmetric and positive semi-definite for any admissible
    /// rows, which is what keeps the Cholesky and the CG applicable (plan B §0).
    #[test]
    fn t_transpose_k_t_is_symmetric_and_psd(seed in 1u64..512u64) {
        let n = 6;
        let mut r = Lcg(seed.wrapping_mul(2_654_435_761));
        // K = LᵀL + I is symmetric positive definite for any L.
        let l: Vec<f64> = (0..n * n).map(|_| 2.0 * r.unit() - 1.0).collect();
        let mut k = mat_mul_t(&l, &l, n);
        for d in 0..n {
            k[d * n + d] += 1.0;
        }
        // Two slaves, each leaning on masters that are neither slaves nor each other.
        let (a0, a1) = (r.unit(), r.unit());
        let mpc = hand_mpc(vec![
            Row { slave: 4, masters: vec![(0, a0), (1, 1.0 - a0)], owner: 0 },
            Row { slave: 5, masters: vec![(2, a1), (3, 1.0 - a1)], owner: 0 },
        ]);
        let (kt, _) = mpc::transform(&dense_csr(n, &k), &vec![0.0; n], &mpc);
        let d = to_dense(&kt);
        for i in 0..n {
            for j in 0..n {
                let (x, y) = (d[i * n + j], d[j * n + i]);
                proptest::prop_assert!((x - y).abs() <= 1e-9 * (1.0 + x.abs()), "({i}, {j}): {x} vs {y}");
            }
        }
        for _ in 0..8 {
            let v: Vec<f64> = (0..n).map(|_| 2.0 * r.unit() - 1.0).collect();
            let q: f64 = (0..n).map(|i| v[i] * (0..n).map(|j| d[i * n + j] * v[j]).sum::<f64>()).sum();
            proptest::prop_assert!(q >= -1e-9, "vᵀTᵀKTv = {q}");
        }
    }
}

/// Every node seeds its own diagonal, so a node no element touches still owns one, and
/// `pattern_coupled` makes room for entries no element creates.
#[test]
fn the_pattern_seeds_its_own_diagonal_and_takes_extra_pairs() {
    let mut mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
    let lonely = mesh.n_nodes() as u32;
    mesh.coords.extend_from_slice(&[5.0, 5.0, 5.0]);
    let pat = pattern(&mesh, 3);
    assert_eq!(pat.csr.diag().len(), mesh.n_nodes() * 3);
    for d in 0..3u32 {
        let row = (3 * lonely + d) as usize;
        let cols = &pat.csr.col_idx[pat.csr.row_ptr[row] as usize..pat.csr.row_ptr[row + 1] as usize];
        assert_eq!(cols, &[3 * lonely, 3 * lonely + 1, 3 * lonely + 2][..], "the lonely node owns a 3×3 block");
    }
    // Without the pair the lonely node couples to nothing; with it, both triangles appear.
    let coupled = pattern_coupled(&mesh, 3, &[[0, lonely]]);
    let row = &coupled.csr.col_idx[coupled.csr.row_ptr[0] as usize..coupled.csr.row_ptr[1] as usize];
    assert!(row.contains(&(3 * lonely)), "node 0 now reaches the lonely node");
    let lo = coupled.csr.row_ptr[3 * lonely as usize] as usize;
    let hi = coupled.csr.row_ptr[3 * lonely as usize + 1] as usize;
    assert!(coupled.csr.col_idx[lo..hi].contains(&0), "and the lonely node reaches back");
    assert!(coupled.csr.nnz() > pat.csr.nnz(), "the extra pair adds entries");
}

/// F4: the two-block tie patch test on matched meshes. A tied assembly under uniform tension
/// carries the same constant stress as one Body: the displacement is exactly the linear field
/// and the reactions balance the applied load.
#[test]
fn f4_a_matched_tie_passes_the_uniform_tension_patch_test() {
    patch_test_across_a_tie([2, 2, 2], [2, 2, 2]);
}

/// F4b: the same patch test with the slave block meshed at half the master's size, so every
/// pairing is a projection into the interior of a master face rather than a node match.
#[test]
fn f4b_a_refined_slave_passes_the_same_patch_test() {
    patch_test_across_a_tie([2, 2, 2], [4, 4, 4]);
}

/// The uniform-tension patch test over two tied blocks meshed `na` and `nb`.
fn patch_test_across_a_tie(na: [usize; 3], nb: [usize; 3]) {
    let sigma = 1.0e6;
    let mesh = two_blocks(ElementKind::Hex8, na, nb, [1.0, 1.0, 1.0], 0.0);
    let sets = sets_of(&mesh);
    let bodies = two_bodies();
    let constraints = vec![
        fix("root", "a.xmin", [true, false, false], 0.0),
        fix("symy", "a.ymin", [false, true, false], 0.0),
        fix("symz", "a.zmin", [false, false, true], 0.0),
    ];
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, constraints);
    p.couplings = vec![bond(1e-9)];
    p.loads = vec![Load::Traction { faces: "b.xmax".into(), t: [sigma, 0.0, 0.0] }];
    assert!(checks::all(&p).is_empty(), "{:?}", checks::all(&p));
    let res = run_step(&p, &static_step(SolveOptions::default())).expect("a tied static solve");
    assert!(res.warnings.is_empty(), "{:?}", res.warnings);

    let u = &res.fields[&Field::Displacement];
    let scale = sigma / YOUNG;
    for node in 0..mesh.n_nodes() {
        let x = mesh.node(node as u32);
        let want = [scale * x[0], -POISSON * scale * x[1], -POISSON * scale * x[2]];
        for (c, w) in want.iter().enumerate() {
            let got = u.data[node * u.comps + c];
            assert!((got - w).abs() <= 1e-8 * scale, "node {node} component {c}: got {got}, want {w}");
        }
    }
    for (node, got) in res.fields[&Field::VonMises].data.iter().enumerate() {
        assert!((got - sigma).abs() <= 1e-7 * sigma, "node {node}: von Mises {got} is not the constant {sigma}");
    }
    let total: f64 = res.reactions.iter().map(|(_, r)| r[0]).sum();
    assert!((total + sigma).abs() <= 1e-8 * sigma, "reactions sum to {total}, not {}", -sigma);
    assert!((res.scalars["applied_total_x"] - sigma).abs() <= 1e-9 * sigma);
}

/// The tie is exact: a beam split in two and welded back together deflects exactly as the
/// single-Body beam does, and it does so bit-for-bit at one thread and at four.
#[test]
fn a_split_cantilever_matches_the_whole_one_and_is_thread_independent() {
    let whole = Structured { kind: ElementKind::Hex8, n: [8, 2, 2] }.box_([1.0, 0.1, 0.1]);
    let whole_sets = sets_of(&whole);
    let one = one_body();
    let root = |on: &str| vec![fix("root", on, [true, true, true], 0.0)];
    let mut wp = problem(&whole, &whole_sets, &one, Idealisation::Solid3d, Formulation::Full, root("xmin"));
    wp.loads = vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -1e5] }];
    let whole_res = run_step(&wp, &static_step(SolveOptions::default())).expect("the whole beam solves");

    let half = Structured { kind: ElementKind::Hex8, n: [4, 2, 2] }.box_([0.5, 0.1, 0.1]);
    let mesh = join(&half, &half, [0.5, 0.0, 0.0]);
    let sets = sets_of(&mesh);
    let bodies = two_bodies();
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, root("a.xmin"));
    p.couplings = vec![bond(1e-9)];
    p.loads = vec![Load::Traction { faces: "b.xmax".into(), t: [0.0, 0.0, -1e5] }];
    let one_thread = pollster::block_on(procedure::run(
        &p,
        &static_step(SolveOptions::default()),
        &Pool::new(1),
        None,
        None,
        &mut nop,
    ))
    .expect("the tied beam solves");
    let four_threads = pollster::block_on(procedure::run(
        &p,
        &static_step(SolveOptions::default()),
        &Pool::new(4),
        None,
        None,
        &mut nop,
    ))
    .expect("the tied beam solves");

    let at = [1.0, 0.05, 0.05];
    let tip = |res: &StepResult, m: &Mesh| probe(m, &res.fields[&Field::Displacement], at).expect("inside").1[2];
    let (w, s) = (tip(&whole_res, &whole), tip(&one_thread, &mesh));
    assert!((s - w).abs() <= 1e-8 * w.abs(), "tied {s} against whole {w}");
    let (a1, a4) = (&one_thread.fields[&Field::Displacement].data, &four_threads.fields[&Field::Displacement].data);
    for (i, (x, y)) in a1.iter().zip(a4).enumerate() {
        assert_eq!(x.to_bits(), y.to_bits(), "dof {i}: {x} against {y}");
    }
}

/// A support that also masters a tie carries the tie's own force as well as its residual, so
/// the reaction each Constraint reports is the same as in the single-Body model it stands for.
/// Without that the global balance is wrong too, because the slave residual has nowhere to go.
#[test]
fn a_tie_into_a_held_face_reports_the_same_reactions_as_the_whole_body() {
    let whole = Structured { kind: ElementKind::Hex8, n: [4, 2, 2] }.box_([2.0, 1.0, 1.0]);
    let mut whole_sets = sets_of(&whole);
    // The y = 0 face of the first half only, so it shares its far edge with the tie's master.
    whole_sets.insert(
        "side".into(),
        ResolvedSet {
            kind: SetKind::Node,
            faces: Vec::new(),
            nodes: (0..whole.n_nodes() as u32)
                .filter(|&n| whole.node(n)[1] == 0.0 && whole.node(n)[0] <= 1.0)
                .collect(),
            elems: Vec::new(),
        },
    );
    let one = one_body();
    let held = |root: &str, side: &str| {
        vec![fix("root", root, [true, true, true], 0.0), fix("side", side, [true, true, true], 0.0)]
    };
    let mut wp = problem(&whole, &whole_sets, &one, Idealisation::Solid3d, Formulation::Full, held("xmin", "side"));
    wp.loads = vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -1e5] }];
    let whole_res = run_step(&wp, &static_step(SolveOptions::default())).expect("the whole block solves");

    let mesh = two_blocks(ElementKind::Hex8, [2, 2, 2], [2, 2, 2], [1.0, 1.0, 1.0], 0.0);
    let sets = sets_of(&mesh);
    let bodies = two_bodies();
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, held("a.xmin", "a.ymin"));
    p.couplings = vec![bond(1e-9)];
    p.loads = vec![Load::Traction { faces: "b.xmax".into(), t: [0.0, 0.0, -1e5] }];
    let tied = run_step(&p, &static_step(SolveOptions::default())).expect("the tied assembly solves");

    let side = tied.reactions.iter().find(|(n, _)| n == "side").expect("the side support reports").1;
    assert!(side[2].abs() > 1.0, "the side support carries something: {side:?}");
    for ((wn, wr), (tn, tr)) in whole_res.reactions.iter().zip(&tied.reactions) {
        assert_eq!(wn, tn);
        for c in 0..3 {
            let tol = 1e-8 * (1.0 + wr[c].abs());
            assert!((wr[c] - tr[c]).abs() <= tol, "{tn} component {c}: tied {} against whole {}", tr[c], wr[c]);
        }
    }
    let total: f64 = tied.reactions.iter().map(|(_, r)| r[2]).sum();
    assert!((total - 1e5).abs() <= 1e-4, "the supports carry the applied 1e5 N, not {total}");
}

/// The tie carries temperature too: with one DOF per node the same rows are a perfect thermal
/// contact, and a bar cut in two conducts the same linear profile as the whole one.
#[test]
fn a_tie_conducts_as_one_bar_steady_and_transient() {
    let (t0, t1) = (300.0, 400.0);
    let mesh = two_blocks(ElementKind::Hex8, [5, 1, 1], [5, 1, 1], [0.5, 0.1, 0.1], 0.0);
    let sets = sets_of(&mesh);
    let bodies = two_bodies();
    let mut p = heat_problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        conductor(45.0, 7800.0, 460.0),
        vec![hold("cold", "a.xmin", t0), hold("hot", "b.xmax", t1)],
        Vec::new(),
    );
    p.couplings = vec![bond(1e-9)];
    let res = run_step(&p, &steady()).expect("a tied conduction problem");
    for (node, got) in temperature_of(&res).iter().enumerate() {
        let want = t0 + (t1 - t0) * mesh.node(node as u32)[0];
        assert!((got - want).abs() <= 1e-8, "node {node}: {got} against {want}");
    }
    // Conduction through 0.01 m² of k = 45 over 1 m under 100 K is 45 W, in at one end and out
    // at the other; the tie carries the same flux but is not a support and reports nothing.
    let flow: Vec<f64> = res.reactions.iter().map(|(_, r)| r[0]).collect();
    assert!((flow[0] - 45.0).abs() <= 1e-8 * 45.0, "45 W crosses the tie, not {}", flow[0]);
    assert!((flow[0] + flow[1]).abs() <= 1e-8 * 45.0, "the two ends are equal and opposite: {flow:?}");

    let transient = Step::HeatTransient {
        dt: 200.0,
        t_end: 60_000.0,
        theta: 1.0,
        initial: t0,
        output_every: 50,
        amplitude: None,
        solver: SolveOptions::default(),
        control: NonlinearControl::default(),
    };
    let late = run_step(&p, &transient).expect("a tied transient");
    for (node, got) in temperature_of(&late).iter().enumerate() {
        let want = t0 + (t1 - t0) * mesh.node(node as u32)[0];
        assert!((got - want).abs() <= 0.5, "node {node}: {got} against {want}");
    }
    let history = late.history.as_ref().expect("a transient keeps a history");
    for v in &history.values[0] {
        assert!((v - t0).abs() <= 1e-9 || (v - t1).abs() <= 1e-9, "the initial field is uniform apart from the end");
    }
}

// --------------------------------------------------------------- harmonic response

/// One hex8 clamped at `xmin` and guided at `xmax` so the only free displacements are the four
/// axial ones on the loaded face. That face's symmetry group makes the uniform combination its
/// own mode, and a uniform axial traction excites nothing else: the model **is** a single
/// degree of freedom, which is what makes the closed form exact rather than approximate.
fn sdof_bar<'a>(mesh: &'a Mesh, sets: &'a BTreeMap<String, ResolvedSet>, bodies: &'a [String]) -> Problem<'a> {
    let mut p = problem(
        mesh,
        sets,
        bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("root", "xmin", [true, true, true], 0.0), fix("guide", "xmax", [false, true, true], 0.0)],
    );
    p.loads = vec![Load::Traction { faces: "xmax".to_string(), t: [1.0e6, 0.0, 0.0] }];
    p
}

/// `phi_k^T f` per mode, so the test can name the one mode this load drives without asking the
/// procedure under test which one it was.
fn participations(p: &Problem<'_>, modes: &[FieldData]) -> Vec<f64> {
    let dpn = p.dofs_per_node();
    let mut f = vec![0.0; p.n_dofs()];
    assemble_loads(p, &mut f).expect("a traction on a steel face assembles");
    for &(dof, _) in &resolve(p).expect("the constraints resolve").fixed {
        f[dof as usize] = 0.0;
    }
    modes
        .iter()
        .map(|m| {
            (0..m.data.len() / 3)
                .flat_map(|node| (0..dpn).map(move |c| (node * dpn + c, node * 3 + c)))
                .map(|(dof, comp)| m.data[comp] * f[dof])
                .sum()
        })
        .collect()
}

/// Benchmark F14. A single-degree-of-freedom magnification curve is exact for mode
/// superposition, so it is gated at roundoff rather than at an engineering tolerance: any
/// looser and a real error in the complex denominator, the phase convention or the modal
/// participation would pass unnoticed.
///
/// `|u| / u_static = 1 / sqrt((1 - r^2)^2 + (2 zeta r)^2)` and `phase = atan2(2 zeta r, 1 - r^2)`,
/// with `u_static` taken from the independent static procedure and `r = f / f_n` from the
/// independent modal one.
#[test]
fn a_single_degree_of_freedom_sweep_reproduces_the_magnification_closed_form() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = sdof_bar(&mesh, &sets, &bodies);
    let opts = SolveOptions::default();

    let stat = run_step(&p, &static_step(opts)).expect("a guided bar under traction is well posed");
    let tip: Vec<u32> = sets["xmax"].nodes.clone();
    let u_static = stat.fields[&Field::Displacement].data[tip[0] as usize * 3];
    assert!(u_static > 0.0, "the traction pulls the free face outwards: {u_static}");

    // Four free DOFs, four modes: the subspace is the whole space, so the shapes are exact.
    let modal =
        run_step(&p, &Step::Modal { n_modes: 4, shift: None, solver: opts }).expect("a bar with mass has modes");
    let part = participations(&p, &modal.modes);
    let driven = (0..part.len()).fold(0, |best, k| if libm::fabs(part[k]) > libm::fabs(part[best]) { k } else { best });
    let f_n = modal.frequencies[driven];

    for zeta in [0.02, 0.05, 0.2] {
        // 30 points from 0.1 f_n to 3 f_n is r = 0.1, 0.2, ... 3.0.
        let step = harmonic_step(0.1 * f_n, 3.0 * f_n, 30, zeta, 1);
        let res = run_after(&p, &step, Some(&modal)).expect("a harmonic Step after a solved modal one");
        let sweep = res.sweep.as_ref().expect("a harmonic Step keeps its sweep");
        assert_eq!(sweep.frequencies.len(), 30, "outputEvery 1 keeps every point");
        for (i, &hz) in sweep.frequencies.iter().enumerate() {
            let r = hz / f_n;
            let (real, imag) = (1.0 - r * r, 2.0 * zeta * r);
            let want = u_static / libm::sqrt(real * real + imag * imag);
            let want_phase = libm::atan2(imag, real);
            for &node in &tip {
                let got = sweep.amplitude[i].data[node as usize * 3];
                let got_phase = sweep.phase[i].data[node as usize * 3];
                assert!(libm::fabs(got - want) <= 1e-8 * want, "zeta {zeta}, r {r}: {got} against {want}");
                assert!(
                    libm::fabs(got_phase - want_phase) <= 1e-8,
                    "zeta {zeta}, r {r}: phase {got_phase} against {want_phase}"
                );
                // The transverse components are held, so they never respond.
                assert_eq!(sweep.amplitude[i].data[node as usize * 3 + 1], 0.0);
            }
        }
        // The displacement field is the amplitude where the response peaked, and for a lightly
        // damped SDOF that is the grid point nearest resonance.
        let peak = res.scalars["peak_frequency"];
        assert!(libm::fabs(peak - f_n) <= 0.06 * f_n, "the peak sits on resonance: {peak} against {f_n}");
        let at_peak = sweep.frequencies.iter().position(|f| *f == peak).expect("the peak is a retained frequency");
        assert_eq!(res.fields[&Field::Displacement], sweep.amplitude[at_peak]);
        assert_eq!(res.frequencies, modal.frequencies, "the modal basis is reported with the response");
        assert_eq!(res.scalars["zeta_1"], zeta);
        assert_eq!(res.solver.solver, "cpu-modal-superposition");
    }
}

/// Rayleigh damping reaches the same response through the other door: at one frequency,
/// `zeta = alpha/(2w) + beta w / 2` picked to equal a constant ratio gives an identical
/// amplitude and phase there.
#[test]
fn rayleigh_damping_matches_the_constant_ratio_it_reproduces() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = sdof_bar(&mesh, &sets, &bodies);
    let modal = run_step(&p, &Step::Modal { n_modes: 1, shift: None, solver: SolveOptions::default() })
        .expect("a bar with mass has modes");
    let w = 2.0 * PI * modal.frequencies[0];
    // beta w / 2 = 0.05 at the natural frequency, with no mass-proportional term.
    let beta = 0.1 / w;
    let constant =
        run_after(&p, &harmonic_step(0.5 * modal.frequencies[0], 2.0 * modal.frequencies[0], 3, 0.05, 1), Some(&modal))
            .expect("a constant ratio sweep");
    let rayleigh = Step::Harmonic {
        f_start: 0.5 * modal.frequencies[0],
        f_stop: 2.0 * modal.frequencies[0],
        points: 3,
        spacing: SweepSpacing::Linear,
        damping_ratio: None,
        rayleigh: (0.0, beta),
        output_every: 1,
    };
    let res = run_after(&p, &rayleigh, Some(&modal)).expect("a Rayleigh damped sweep");
    assert!(libm::fabs(res.scalars["zeta_1"] - 0.05) < 1e-15, "{}", res.scalars["zeta_1"]);
    let (a, b) = (&constant.sweep.expect("a sweep"), &res.sweep.expect("a sweep"));
    let node = sets["xmax"].nodes[0] as usize * 3;
    for i in 0..3 {
        assert!(libm::fabs(a.amplitude[i].data[node] - b.amplitude[i].data[node]) <= 1e-12 * a.amplitude[i].data[node]);
        assert!(libm::fabs(a.phase[i].data[node] - b.phase[i].data[node]) <= 1e-12);
    }
    // Mass-proportional damping at the same frequency is the same ratio the other way round.
    let mass_damped = Step::Harmonic {
        f_start: 0.5 * modal.frequencies[0],
        f_stop: 2.0 * modal.frequencies[0],
        points: 3,
        spacing: SweepSpacing::Linear,
        damping_ratio: None,
        rayleigh: (0.1 * w, 0.0),
        output_every: 1,
    };
    let res = run_after(&p, &mass_damped, Some(&modal)).expect("a mass-proportional sweep");
    assert!(libm::fabs(res.scalars["zeta_1"] - 0.05) < 1e-15, "{}", res.scalars["zeta_1"]);
}

/// A harmonic Step without a solved modal Step behind it says so, whether `after` named
/// nothing at all or named a Step that produced no frequencies.
#[test]
fn a_harmonic_step_needs_the_modes_it_superposes() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = sdof_bar(&mesh, &sets, &bodies);
    let step = harmonic_step(10.0, 100.0, 5, 0.02, 1);
    let stat = run_step(&p, &static_step(SolveOptions::default())).expect("a static Result has no frequencies");
    for (previous, where_) in [(None, "step.procedure"), (Some(&stat), "after")] {
        let error = run_after(&p, &step, previous).expect_err("no modes, no response");
        assert_eq!(error.code, ErrorCode::NotFound);
        assert_eq!(error.where_.as_deref(), Some(where_));
        assert!(error.suggestion.expect("a way out").contains("modal"));
    }
}

/// A moving support is base excitation, which mode superposition against a fixed-base modal
/// basis cannot represent. It is refused rather than silently answered with a zero.
#[test]
fn a_harmonic_step_refuses_a_prescribed_displacement() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let mut p = sdof_bar(&mesh, &sets, &bodies);
    let modal = run_step(&p, &Step::Modal { n_modes: 1, shift: None, solver: SolveOptions::default() })
        .expect("a bar with mass has modes");
    p.constraints = vec![fix("root", "xmin", [true, true, true], 1e-3)];
    let error = run_after(&p, &harmonic_step(10.0, 100.0, 5, 0.02, 1), Some(&modal))
        .expect_err("base excitation is not this procedure");
    assert_eq!(error.code, ErrorCode::Unsupported);
    assert_eq!(error.where_.as_deref(), Some("step.constraints"));
    assert!(error.suggestion.expect("a way out").contains("load.force"));
}

/// `outputEvery` strides a sweep exactly as it strides a transient: the first frequency, every
/// n-th one after it, and the last whatever the arithmetic says.
#[test]
fn a_sweep_retains_the_first_the_stride_and_the_last_frequency() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = sdof_bar(&mesh, &sets, &bodies);
    let modal = run_step(&p, &Step::Modal { n_modes: 1, shift: None, solver: SolveOptions::default() })
        .expect("a bar with mass has modes");
    let res = run_after(&p, &harmonic_step(10.0, 70.0, 7, 0.02, 3), Some(&modal)).expect("a strided sweep");
    let sweep = res.sweep.expect("a harmonic Step keeps its sweep");
    assert_eq!(sweep.clone(), sweep, "a Sweep is comparable and cloneable like every Result member");
    assert!(format!("{sweep:?}").contains("frequencies"));
    assert_eq!(sweep.frequencies, vec![10.0, 40.0, 70.0]);
    assert_eq!(sweep.amplitude.len(), 3);
    assert_eq!(sweep.phase.len(), 3);
    assert_eq!(res.scalars["retained_frequencies"], 3.0);
    assert_eq!(res.scalars["sweep_points"], 7.0);
}

/// A sweep the schema cannot build is refused before any mode is touched.
#[test]
fn an_unusable_sweep_stops_the_harmonic_step() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = sdof_bar(&mesh, &sets, &bodies);
    let modal = run_step(&p, &Step::Modal { n_modes: 1, shift: None, solver: SolveOptions::default() })
        .expect("a bar with mass has modes");
    let error = run_after(&p, &harmonic_step(10.0, 70.0, 1, 0.02, 1), Some(&modal)).expect_err("one point is no sweep");
    assert_eq!(error.code, ErrorCode::Schema);
    assert_eq!(error.where_.as_deref(), Some("points"));
}

/// The Loads and the Constraints of a harmonic Step are its own, and both report what they
/// cannot resolve rather than answering with a silent zero.
#[test]
fn a_harmonic_step_reports_a_load_or_a_constraint_it_cannot_resolve() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let modal = run_step(
        &sdof_bar(&mesh, &sets, &bodies),
        &Step::Modal { n_modes: 1, shift: None, solver: SolveOptions::default() },
    )
    .expect("a bar with mass has modes");
    let step = harmonic_step(10.0, 100.0, 5, 0.02, 1);

    let mut bad_load = sdof_bar(&mesh, &sets, &bodies);
    bad_load.loads = vec![Load::Traction { faces: "nowhere".to_string(), t: [1.0, 0.0, 0.0] }];
    assert_eq!(run_after(&bad_load, &step, Some(&modal)).expect_err("no such Set").code, ErrorCode::SetEmpty);

    let mut bad_hold = sdof_bar(&mesh, &sets, &bodies);
    bad_hold.constraints = vec![fix("root", "nowhere", [true, true, true], 0.0)];
    assert_eq!(run_after(&bad_hold, &step, Some(&modal)).expect_err("no such Set").code, ErrorCode::SetEmpty);
}

/// A tied assembly has the frequencies of the single Body it models, and its recovered mode
/// shapes are continuous across the tie.
#[test]
fn a_tied_beam_has_the_frequencies_of_the_whole_one() {
    let modal = Step::Modal { n_modes: 2, shift: None, solver: SolveOptions::default() };
    let root = |on: &str| vec![fix("root", on, [true, true, true], 0.0)];
    let whole = Structured { kind: ElementKind::Hex8, n: [8, 2, 2] }.box_([1.0, 0.1, 0.1]);
    let whole_sets = sets_of(&whole);
    let one = one_body();
    let wp = problem(&whole, &whole_sets, &one, Idealisation::Solid3d, Formulation::Full, root("xmin"));
    let whole_res = run_step(&wp, &modal).expect("the whole beam has modes");

    let half = Structured { kind: ElementKind::Hex8, n: [4, 2, 2] }.box_([0.5, 0.1, 0.1]);
    let mesh = join(&half, &half, [0.5, 0.0, 0.0]);
    let sets = sets_of(&mesh);
    let bodies = two_bodies();
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, root("a.xmin"));
    p.couplings = vec![bond(1e-9)];
    let tied = run_step(&p, &modal).expect("the tied beam has modes");
    for (i, (w, t)) in whole_res.frequencies.iter().zip(&tied.frequencies).enumerate() {
        assert!((w - t).abs() <= 1e-6 * w, "mode {i}: tied {t} against whole {w}");
    }
    let shape = &tied.modes[0];
    let mut pairs = 0;
    for s in 0..half.n_nodes() as u32 {
        let x = half.node(s);
        if x[0] != 0.5 {
            continue;
        }
        // The coincident node of the second block: the same point, at its own local origin.
        let slave = node_at(&half, [0.0, x[1], x[2]]) as usize + half.n_nodes();
        pairs += 1;
        for c in 0..3 {
            let (m, sl) = (shape.data[s as usize * shape.comps + c], shape.data[slave * shape.comps + c]);
            assert!((m - sl).abs() <= 1e-12 * (1.0 + m.abs()), "node {s} component {c}: {m} against {sl}");
        }
    }
    assert_eq!(pairs, 9, "every node of the interface was checked");
}

/// The two pairing warnings reach the Result: a gap the tie bridges, and a slave side coarser
/// than the master it projects onto.
#[test]
fn the_pairing_warnings_reach_the_result() {
    let mesh = two_blocks(ElementKind::Hex8, [4, 4, 4], [2, 2, 2], [1.0, 1.0, 1.0], 1e-5);
    let sets = sets_of(&mesh);
    let bodies = two_bodies();
    let mut p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("root", "a.xmin", [true, true, true], 0.0)],
    );
    p.couplings = vec![bond(1e-3)];
    p.loads = vec![Load::Traction { faces: "b.xmax".into(), t: [1e5, 0.0, 0.0] }];
    let res = run_step(&p, &static_step(SolveOptions::default())).expect("a tied solve across a gap");
    let codes: Vec<&str> = res.warnings.iter().map(|w| w.code.as_str()).collect();
    assert_eq!(codes, vec!["contact.slave-coarser", "contact.gap"], "{:?}", res.warnings);
    assert!(res.warnings[0].text.contains("9 nodes on the slave set"), "{}", res.warnings[0].text);
    assert!(res.warnings[1].text.contains("0.00001"), "{}", res.warnings[1].text);
    for w in &res.warnings {
        assert_eq!(w.where_.as_deref(), Some("contact 'weld'"));
    }
}

/// A gap the tie bridges is a rigid link, so it removes the rotation a single pinned node
/// leaves free — which the rigid-mode check only sees because it tests the tie rows too.
#[test]
fn a_tie_across_a_gap_removes_a_rotation_the_supports_leave() {
    let half = Structured { kind: ElementKind::Quad4, n: [2, 2, 1] }.box_([1.0, 1.0, 0.0]);
    let mesh = join(&half, &half, [1.1, 0.0, 0.0]);
    let mut sets = sets_of(&mesh);
    sets.insert(
        "pin".into(),
        ResolvedSet { kind: SetKind::Node, faces: Vec::new(), nodes: vec![0], elems: Vec::new() },
    );
    let bodies = two_bodies();
    let id = Idealisation::PlaneStress { thickness: 0.1 };
    let held = vec![fix("pin", "pin", [true, true, false], 0.0)];
    let free = problem(&mesh, &sets, &bodies, id.clone(), Formulation::Full, held.clone());
    let spin = checks::all(&free);
    assert_eq!(spin.len(), 1);
    assert_eq!(spin[0].code, ErrorCode::ConstraintRigidModes);
    assert!(spin[0].cause.contains("rotation about z"), "{}", spin[0].cause);

    let mut tied = problem(&mesh, &sets, &bodies, id, Formulation::Full, held);
    tied.couplings = vec![bond(0.2)];
    assert!(checks::all(&tied).is_empty(), "the tie holds the second block: {:?}", checks::all(&tied));
}

/// A node further from the master Set than the tolerance is `contact.unpaired`, naming the node,
/// the distance and the nearest master face.
#[test]
fn a_node_beyond_the_tolerance_is_unpaired() {
    let mesh = two_blocks(ElementKind::Hex8, [1, 1, 1], [1, 1, 1], [1.0, 1.0, 1.0], 0.05);
    let sets = sets_of(&mesh);
    let bodies = two_bodies();
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    p.couplings = vec![bond(0.01)];
    let e = mpc::build(&p).expect_err("0.05 m is beyond a 0.01 m tolerance");
    assert_eq!(e.code, ErrorCode::ContactUnpaired);
    assert!(e.cause.contains("0.05"), "{}", e.cause);
    assert!(e.cause.contains("centred at [1, 0.5, 0.5]"), "{}", e.cause);
    assert_eq!(e.where_.as_deref(), Some("contact 'weld'"));
    assert!(e.suggestion.as_deref().is_some_and(|s| s.contains("larger tol")));
    // The checks report it, and a solve refuses on it rather than welding across the gap.
    let all = checks::all(&p);
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].code, ErrorCode::ContactUnpaired);
    assert_eq!(
        run_step(&p, &static_step(SolveOptions::default())).expect_err("refused").code,
        ErrorCode::ContactUnpaired
    );
}

/// A DOF two ties both eliminate, and one that is a slave here and a master there: either makes
/// `T` rank-deficient, so both are refused before anything is assembled.
#[test]
fn a_dof_that_two_ties_claim_is_dependent() {
    let mesh = two_blocks(ElementKind::Hex8, [1, 1, 1], [1, 1, 1], [1.0, 1.0, 1.0], 0.0);
    let sets = sets_of(&mesh);
    let bodies = two_bodies();
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    p.couplings = vec![bond(1e-9), tie("again", "a.xmax", "b.xmin", 1e-9)];
    let twice = mpc::build(&p).expect_err("the same face cannot be tied twice");
    assert_eq!(twice.code, ErrorCode::ConstraintDependent);
    assert!(twice.cause.starts_with("ux of node"), "{}", twice.cause);
    assert!(twice.cause.contains("is tied twice"), "{}", twice.cause);
    assert!(twice.cause.contains("'weld' and 'again'"), "{}", twice.cause);
    assert_eq!(twice.where_.as_deref(), Some("contact 'again'"));
    assert!(twice.suggestion.as_deref().is_some_and(|s| s.contains("constraint.remove")));

    // The second tie makes the first tie's slave face into a master face.
    p.couplings = vec![bond(1e-9), tie("chain", "b.xmin", "a.xmin", 2.0)];
    let chained = mpc::build(&p).expect_err("a slave may not also be a master");
    assert_eq!(chained.code, ErrorCode::ConstraintDependent);
    assert!(chained.cause.contains("is both a slave and a master"), "{}", chained.cause);
    assert_eq!(chained.where_.as_deref(), Some("contact 'chain'"));
}

/// A Constraint and a tie cannot both own a DOF: the elimination would win silently, so the
/// clash is a `constraint.conflict` naming both.
#[test]
fn a_prescribed_slave_dof_conflicts_with_its_tie() {
    let mesh = two_blocks(ElementKind::Hex8, [1, 1, 1], [1, 1, 1], [1.0, 1.0, 1.0], 0.0);
    let sets = sets_of(&mesh);
    let bodies = two_bodies();
    let constraints = vec![fix("clamp", "b.xmin", [true, true, true], 0.0)];
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, constraints);
    p.couplings = vec![bond(1e-9)];
    let e = checks::all(&p).into_iter().find(|e| e.code == ErrorCode::ConstraintConflict).expect("a clash");
    assert!(e.cause.contains("'clamp' prescribes ux of node"), "{}", e.cause);
    assert!(e.cause.contains("contact 'weld' ties it"), "{}", e.cause);
    assert_eq!(e.where_.as_deref(), Some("contact 'weld'"));
}

/// The Sets a tie names must exist, must not be the same Set, and the master must have faces:
/// there is nothing to project onto otherwise.
#[test]
fn a_tie_needs_two_real_face_sets() {
    let mesh = two_blocks(ElementKind::Hex8, [1, 1, 1], [1, 1, 1], [1.0, 1.0, 1.0], 0.0);
    let mut sets = sets_of(&mesh);
    let nodes = sets["a.xmax"].nodes.clone();
    sets.insert("loose".into(), ResolvedSet { kind: SetKind::Node, faces: Vec::new(), nodes, elems: Vec::new() });
    let bodies = two_bodies();
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());

    p.couplings = vec![tie("weld", "nope", "b.xmin", 1e-9)];
    let missing = mpc::build(&p).expect_err("an unknown master Set");
    assert_eq!(missing.code, ErrorCode::SetEmpty);
    assert_eq!(missing.where_.as_deref(), Some("contact 'weld'"));

    p.couplings = vec![tie("weld", "a.xmax", "nope", 1e-9)];
    assert_eq!(mpc::build(&p).expect_err("an unknown slave Set").code, ErrorCode::SetEmpty);

    p.couplings = vec![tie("weld", "loose", "b.xmin", 1e-9)];
    let not_a_face = mpc::build(&p).expect_err("a node Set cannot be a master");
    assert_eq!(not_a_face.code, ErrorCode::Schema);
    assert!(not_a_face.cause.contains("which has no faces"), "{}", not_a_face.cause);

    p.couplings = vec![tie("weld", "a.xmax", "a.xmax", 1e-9)];
    let itself = mpc::build(&p).expect_err("a Set cannot be tied to itself");
    assert_eq!(itself.code, ErrorCode::ModelIllPosed);
    assert!(itself.cause.contains("to itself"), "{}", itself.cause);

    // An empty Set is reported by the well-posedness checks before the pairing runs.
    sets.insert(
        "void".into(),
        ResolvedSet { kind: SetKind::Face, faces: Vec::new(), nodes: Vec::new(), elems: Vec::new() },
    );
    let mut q = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    q.couplings = vec![tie("weld", "void", "b.xmin", 1e-9)];
    assert_eq!(checks::all(&q)[0].code, ErrorCode::SetEmpty);
}

/// Central differences divide by a lumped mass, and `TᵀMT` of a diagonal is not diagonal, so an
/// explicit Step with a tie is refused rather than quietly integrating the wrong equations.
#[test]
fn explicit_dynamics_refuses_a_tie() {
    let mesh = two_blocks(ElementKind::Hex8, [1, 1, 1], [1, 1, 1], [1.0, 1.0, 1.0], 0.0);
    let sets = sets_of(&mesh);
    let bodies = two_bodies();
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    p.couplings = vec![bond(1e-9)];
    let step = Step::Explicit { t_end: 1e-6, dt_factor: 0.9, initial_velocity: None, output_every: 1 };
    let e = run_step(&p, &step).expect_err("explicit dynamics cannot carry a tie");
    assert_eq!(e.code, ErrorCode::Unsupported);
    assert!(e.cause.contains("'weld' ties two parts"), "{}", e.cause);
    assert_eq!(e.where_.as_deref(), Some("step.procedure"));
    assert!(e.suggestion.as_deref().is_some_and(|s| s.contains("procedure 'static'")));
}

/// The projection is a real closest-point search: one parameter on a 2D element's edge, two on
/// a triangle, and a node that falls off its master face clamps onto the nearest corner or edge
/// instead of extrapolating the face.
#[test]
fn the_projection_clamps_a_node_that_falls_off_its_master_face() {
    // 2D: `b` is twice as tall, so its top edge node is a metre past the end of `a`'s edge.
    let left = Structured { kind: ElementKind::Quad4, n: [2, 2, 1] }.box_([1.0, 1.0, 0.0]);
    let right = Structured { kind: ElementKind::Quad4, n: [2, 3, 1] }.box_([1.0, 2.0, 0.0]);
    let mesh = join(&left, &right, [1.0, 0.0, 0.0]);
    let sets = sets_of(&mesh);
    let bodies = two_bodies();
    let mut p =
        problem(&mesh, &sets, &bodies, Idealisation::PlaneStress { thickness: 0.1 }, Formulation::Full, Vec::new());
    p.couplings = vec![bond(1.1)];
    let m = mpc::build(&p).expect("every node pairs within 1.1 m");
    let clamped = node_at(&mesh, [1.0, 2.0, 0.0]);
    let corner = node_at(&mesh, [1.0, 1.0, 0.0]);
    let row = m.rows.iter().find(|r| r.slave == 2 * clamped).expect("the far node is tied");
    assert_eq!(row.masters, vec![(2 * corner, 1.0)], "it clamps onto the corner, exactly");
    let inside = m.rows.iter().find(|r| r.masters.len() == 2).expect("an interior projection has two masters");
    assert!((inside.masters.iter().map(|&(_, a)| a).sum::<f64>() - 1.0).abs() < 1e-12);

    // Triangles: matched tetrahedron faces pair exactly, node onto node.
    let tets = two_blocks(ElementKind::Tet4, [1, 1, 1], [1, 1, 1], [1.0, 1.0, 1.0], 0.0);
    let tet_sets = sets_of(&tets);
    let mut tp = problem(&tets, &tet_sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    tp.couplings = vec![bond(1e-9)];
    for row in &mpc::build(&tp).expect("matched tetrahedron faces pair").rows {
        assert_eq!(row.masters.len(), 1, "a coincident node ties to one node");
        assert_eq!(row.masters[0].1, 1.0, "with a weight of exactly one");
    }
    // Slid sideways, half of them fall off their triangle and clamp onto its edge.
    let cube = Structured { kind: ElementKind::Tet4, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
    let slid = join(&cube, &cube, [1.0, 0.8, 0.0]);
    let slid_sets = sets_of(&slid);
    let mut sp = problem(&slid, &slid_sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    sp.couplings = vec![bond(1.5)];
    let sm = mpc::build(&sp).expect("a 0.8 m offset still pairs within 1.5 m");
    for row in &sm.rows {
        let sum: f64 = row.masters.iter().map(|&(_, a)| a).sum();
        assert!((sum - 1.0).abs() < 1e-12, "clamped weights are still a partition of unity: {sum}");
    }
    let off = node_at(&slid, [1.0, 1.8, 0.0]);
    let row = sm.rows.iter().find(|r| r.slave == 3 * off).expect("the far node is tied");
    assert!(row.masters.len() <= 2, "a node past the triangle clamps onto an edge or a corner: {row:?}");
}

// -------------------------------------------------------- point masses and couplings (#67)

/// A `geometry.addMass` node appended to a Mesh: one more coordinate and no element, which is
/// what `mesh::build` makes of a `Model.points` entry.
fn lugged(n: [usize; 3], at: [f64; 3]) -> (Mesh, u32) {
    let mut mesh = cantilever_mesh(n, ElementKind::Hex8);
    let node = mesh.n_nodes() as u32;
    mesh.coords.extend_from_slice(&at);
    (mesh, node)
}

/// The resolved point-mass Set the Mesh builder inserts alongside it.
fn point_set(node: u32) -> ResolvedSet {
    ResolvedSet { kind: SetKind::Node, faces: Vec::new(), nodes: vec![node], elems: Vec::new() }
}

/// The Sets of a lugged cantilever, with the point's own node Set called `lug`.
fn lug_sets(mesh: &Mesh, node: u32) -> BTreeMap<String, ResolvedSet> {
    let mut sets = sets_of(mesh);
    sets.insert("lug".into(), point_set(node));
    sets
}

fn lug(node: u32, mass: f64) -> Vec<PointMass> {
    vec![PointMass { name: "lug".into(), node, mass }]
}

fn couple(name: &str, node: u32, faces: &str, kind: CoupleKind) -> Coupling {
    Coupling::Couple { name: name.into(), point: "lug".into(), node, faces: faces.into(), kind }
}

fn clamped() -> Vec<Constraint> {
    vec![fix("root", "xmin", [true, true, true], 0.0)]
}

/// `Σ r × R` of a reaction field: the moment the supports carry about the origin, which for a
/// cantilever clamped at `x = 0` is the moment about its fixed face.
fn reaction_moment(mesh: &Mesh, res: &StepResult) -> [f64; 3] {
    let r = &res.fields[&Field::Reaction];
    let mut m = [0.0; 3];
    for node in 0..mesh.n_nodes() {
        let x = mesh.node(node as u32);
        let f = [r.data[node * 3], r.data[node * 3 + 1], r.data[node * 3 + 2]];
        m[0] += x[1] * f[2] - x[2] * f[1];
        m[1] += x[2] * f[0] - x[0] * f[2];
        m[2] += x[0] * f[1] - x[1] * f[0];
    }
    m
}

/// F12: a distributed coupling is a load introduction and nothing else. A force at a point that
/// is nowhere near the face arrives on that face as the traction of the same total: the
/// deflection is the traction model's to the last digit, the resultant reaches the supports,
/// and the reaction moment is the moment of the *face centroid* rather than of the point —
/// which is what "the coupling transmits no moment" means in numbers.
#[test]
fn f5_a_distributed_coupling_introduces_exactly_the_traction_it_replaces() {
    let force = -1.0e3;
    let bodies = one_body();

    // The traction oracle: the same total spread over the same face by the face quadrature.
    let plain = cantilever_mesh([8, 2, 2], ElementKind::Hex8);
    let plain_sets = sets_of(&plain);
    let mut tp = problem(&plain, &plain_sets, &bodies, Idealisation::Solid3d, Formulation::Full, clamped());
    let area = face_set_area(&tp, "xmax").expect("the tip face has an area");
    tp.loads = vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, force / area] }];
    let traction = run_step(&tp, &static_step(SolveOptions::default())).expect("the traction model solves");

    // The coupled model: one node well outside the beam, carrying the whole force.
    let (mesh, node) = lugged([8, 2, 2], [1.5, 0.2, 0.05]);
    let sets = lug_sets(&mesh, node);
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, clamped());
    p.points = lug(node, 3.0);
    p.couplings = vec![couple("intro", node, "xmax", CoupleKind::Distributed)];
    p.loads = vec![Load::NodalForce { nodes: "lug".into(), f: [0.0, 0.0, force] }];
    assert!(checks::all(&p).is_empty(), "{:?}", checks::all(&p));
    let coupled = run_step(&p, &static_step(SolveOptions::default())).expect("the coupled model solves");

    let at = [1.0, 0.05, 0.05];
    let want = probe(&plain, &traction.fields[&Field::Displacement], at).expect("inside").1[2];
    let got = probe(&mesh, &coupled.fields[&Field::Displacement], at).expect("inside").1[2];
    assert!((got - want).abs() <= 1e-10 * want.abs(), "coupled tip {got} against traction {want}");

    // The point itself rides the face's weighted mean, which on this tip face is its centre.
    let mean = coupled.fields[&Field::Displacement].data[node as usize * 3 + 2];
    assert!((mean - want).abs() <= 0.05 * want.abs(), "the point follows the face: {mean} against {want}");

    let total: f64 = coupled.reactions.iter().map(|(_, r)| r[2]).sum();
    assert!((total + force).abs() <= 1e-10 * force.abs(), "reactions sum to {total}, not {}", -force);
    let m = reaction_moment(&mesh, &coupled);
    // −(x̄ × F) for x̄ the tip face centroid (1, 0.05, 0.05) and F = (0, 0, force). A coupling
    // that carried the offset as a moment would put the arm at the point's x = 1.5 m instead.
    let want_m = [-0.05 * force, force, 0.0];
    for c in 0..3 {
        let tol = 1e-10 * force.abs();
        assert!((m[c] - want_m[c]).abs() <= tol, "reaction moment {c}: {} against {}", m[c], want_m[c]);
    }
}

/// A rigid coupling is the opposite: every node of the face takes the point's displacement, so
/// the face translates as one and cannot deform, and the beam is stiffer than the distributed
/// model. The applied force still reaches the supports in full.
///
/// It does not carry the applied *moment*, and cannot: the subspace `u = T v` it restricts the
/// model to holds no rigid rotation, because a rotation moves the face's nodes differently and
/// this coupling forbids that. The constraint holds the face flat and supplies whatever moment
/// that takes; `constraint.couple`'s doc string says so. What a user may rely on is the
/// resultant, which is what this pins.
#[test]
fn a_rigid_coupling_makes_its_whole_face_move_as_one() {
    let force = -1.0e3;
    let (mesh, node) = lugged([8, 2, 2], [1.5, 0.2, 0.05]);
    let sets = lug_sets(&mesh, node);
    let bodies = one_body();
    let mut tip = Vec::new();
    for kind in [CoupleKind::Distributed, CoupleKind::Rigid] {
        let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, clamped());
        p.points = lug(node, 1.0);
        p.couplings = vec![couple("intro", node, "xmax", kind)];
        p.loads = vec![Load::NodalForce { nodes: "lug".into(), f: [0.0, 0.0, force] }];
        let res = run_step(&p, &static_step(SolveOptions::default())).expect("both couplings solve");
        let total: f64 = res.reactions.iter().map(|(_, r)| r[2]).sum();
        assert!((total + force).abs() <= 1e-9 * force.abs(), "reactions sum to {total}, not {}", -force);
        tip.push(res.fields[&Field::Displacement].clone());
    }
    let u = &tip[1];
    let want: Vec<f64> = (0..3).map(|c| u.data[node as usize * 3 + c]).collect();
    for &n in &sets["xmax"].nodes {
        for (c, w) in want.iter().enumerate() {
            let got = u.data[n as usize * 3 + c];
            assert!((got - w).abs() <= 1e-12 * (1.0 + w.abs()), "node {n} component {c}: {got} against {w}");
        }
    }
    let soft = tip[0].data[node as usize * 3 + 2];
    assert!(want[2].abs() < soft.abs(), "a face held flat is stiffer: {} against {soft}", want[2]);
}

/// A point mass is mass and nothing else: it lands on its own node's translational diagonal,
/// gravity finds it there, and it creates no new entry in the operator.
#[test]
fn a_point_mass_adds_only_mass_and_weight() {
    let (mesh, node) = lugged([2, 1, 1], [1.5, 0.2, 0.05]);
    let sets = lug_sets(&mesh, node);
    let bodies = one_body();
    let g = [0.0, 0.0, -9.81];
    let beam_mass = DENSITY * 1.0 * 0.1 * 0.1;
    let lump = 25.0;

    let bare = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    let pat = pattern(&mesh, 3);
    let m0 = assemble_mass(&bare, &pat, false).expect("the beam has a density");
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    p.points = lug(node, lump);
    p.couplings = vec![couple("intro", node, "xmax", CoupleKind::Distributed)];
    let m1 = assemble_mass(&p, &pat, false).expect("the beam has a density");

    let (d0, d1) = (m0.diag(), m1.diag());
    for (dof, (a, b)) in d0.iter().zip(&d1).enumerate() {
        let want = if dof / 3 == node as usize { lump } else { 0.0 };
        assert!((b - a - want).abs() <= 1e-9 * (1.0 + want), "dof {dof}: {a} became {b}");
    }
    assert_eq!(m0.col_idx, m1.col_idx, "a point mass creates no new operator entry");
    // The sum of a consistent mass matrix, divided by the components, is the total mass.
    let total: f64 = m1.vals.iter().sum::<f64>() / 3.0;
    assert!((total - beam_mass - lump).abs() <= 1e-9 * (beam_mass + lump), "total mass {total}");

    p.loads = vec![Load::Gravity { g }];
    let mut f = vec![0.0; p.n_dofs()];
    let applied = assemble_loads(&p, &mut f).expect("gravity assembles");
    let want = (beam_mass + lump) * g[2];
    assert!((applied.force[2] - want).abs() <= 1e-9 * want.abs(), "weight {} against {want}", applied.force[2]);
    let at_point = f[node as usize * 3 + 2];
    assert!((at_point - lump * g[2]).abs() <= 1e-12 * (lump * g[2]).abs(), "m g at the point: {at_point}");
}

/// A point mass nothing couples has mass and no stiffness at all, which is a singular system
/// however it is solved; the checks name it before the factorisation meets it.
#[test]
fn an_unattached_point_mass_is_ill_posed() {
    let (mesh, node) = lugged([1, 1, 1], [1.5, 0.2, 0.05]);
    let sets = lug_sets(&mesh, node);
    let bodies = one_body();
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, clamped());
    p.points = lug(node, 1.0);
    let e = &checks::all(&p)[0];
    assert_eq!(e.code, ErrorCode::ModelIllPosed);
    assert!(e.cause.contains("point mass 'lug' is attached to nothing"), "{}", e.cause);
    assert_eq!(e.where_.as_deref(), Some("point mass 'lug'"));
    assert!(e.suggestion.as_deref().is_some_and(|s| s.contains("constraint.couple")));
    // A bonded contact attaches Bodies, never a point: only a coupling names one.
    p.couplings = vec![tie("weld", "xmax", "xmin", 1.0)];
    assert!(checks::all(&p).iter().any(|e| e.code == ErrorCode::ModelIllPosed));
    p.couplings = vec![couple("intro", node, "xmax", CoupleKind::Distributed)];
    assert!(checks::all(&p).is_empty(), "{:?}", checks::all(&p));
}

/// A coupling needs a face to weight, and says so when it is handed a node Set or one that is
/// not on the Mesh at all. Two couplings that eliminate the same DOF are `constraint.dependent`,
/// and the error calls them couplings rather than contacts.
#[test]
fn a_coupling_refuses_a_set_that_is_not_a_face() {
    let (mesh, node) = lugged([1, 1, 1], [1.5, 0.2, 0.05]);
    let sets = lug_sets(&mesh, node);
    let bodies = one_body();
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    p.points = lug(node, 1.0);
    for kind in [CoupleKind::Distributed, CoupleKind::Rigid] {
        p.couplings = vec![couple("intro", node, "lug", kind)];
        let e = mpc::build(&p).expect_err("a node Set has no faces to weight");
        assert_eq!(e.code, ErrorCode::Schema);
        assert!(e.cause.contains("which has no faces"), "{}", e.cause);
        assert_eq!(e.where_.as_deref(), Some("coupling 'intro'"));
        assert!(e.suggestion.as_deref().is_some_and(|s| s.contains("face Set")));

        p.couplings = vec![couple("intro", node, "nope", kind)];
        let missing = mpc::build(&p).expect_err("an unknown Set");
        assert_eq!(missing.code, ErrorCode::SetEmpty);
        assert_eq!(missing.where_.as_deref(), Some("coupling 'intro'"));
    }
    p.couplings = vec![couple("a", node, "xmax", CoupleKind::Rigid), couple("b", node, "xmax", CoupleKind::Rigid)];
    let twice = mpc::build(&p).expect_err("one face cannot be rigid to two points");
    assert_eq!(twice.code, ErrorCode::ConstraintDependent);
    assert_eq!(twice.where_.as_deref(), Some("coupling 'b'"));
}

/// A distributed coupling integrates its face, so it needs that Body's material like any other
/// integral, and reports the same `model.no-material` when it is missing. A rigid coupling reads
/// only the node list, so it does not.
#[test]
fn a_distributed_coupling_needs_the_material_of_the_face_it_weights() {
    let (mesh, node) = lugged([1, 1, 1], [1.5, 0.2, 0.05]);
    let sets = lug_sets(&mesh, node);
    let bodies = one_body();
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    p.material_of_block = vec![None];
    p.points = lug(node, 1.0);
    p.couplings = vec![couple("intro", node, "xmax", CoupleKind::Distributed)];
    let e = mpc::build(&p).expect_err("the face integral has no material to read");
    assert_eq!(e.code, ErrorCode::ModelNoMaterial);
    assert!(e.cause.contains("body 'bar'"), "{}", e.cause);
    p.couplings = vec![couple("intro", node, "xmax", CoupleKind::Rigid)];
    assert!(mpc::build(&p).is_ok(), "a rigid coupling reads node numbers, not the material");
}

/// The weights a distributed coupling uses are the face's own `∫ N dS`: a partition of unity,
/// and on a flat linear face the quarter-cell areas each node owns.
#[test]
fn distributed_weights_are_the_faces_own_lumped_areas() {
    let (mesh, node) = lugged([1, 2, 2], [2.0, 0.0, 0.0]);
    let sets = lug_sets(&mesh, node);
    let bodies = one_body();
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    p.points = lug(node, 1.0);
    p.couplings = vec![couple("intro", node, "xmax", CoupleKind::Distributed)];
    let m = mpc::build(&p).expect("the tip face weights");
    assert_eq!(m.rows.len(), 3, "one row per component of the point");
    let corner = node_at(&mesh, [1.0, 0.0, 0.0]);
    let centre = node_at(&mesh, [1.0, 0.05, 0.05]);
    for (c, row) in m.rows.iter().enumerate() {
        assert_eq!(row.slave, node * 3 + c as u32);
        let sum: f64 = row.masters.iter().map(|&(_, a)| a).sum();
        assert!((sum - 1.0).abs() < 1e-14, "a partition of unity: {sum}");
        let weight = |n: u32| row.masters.iter().find(|&&(d, _)| d / 3 == n).expect("a face node").1;
        // Four quad4 faces over a 0.1 m square: a corner owns one quarter of one cell, and the
        // centre node one quarter of each of the four.
        assert!((weight(corner) - 0.0625).abs() < 1e-14, "corner weight {}", weight(corner));
        assert!((weight(centre) - 0.25).abs() < 1e-14, "centre weight {}", weight(centre));
    }
}

/// A dominant lumped mass makes `M` nearly rank-one on the face it is coupled to, so without
/// the iterated block being orthonormalised every subspace column collapses onto the same mode
/// and `X̄ᵀMX̄` is singular — which used to abort the solve. Six modes on a tip mass six times
/// the beam's own is that case. Benchmark F13 gates the frequency against Rayleigh's formula;
/// what this pins is that the iteration survives at all, and that the mass is doing its work.
#[test]
fn a_dominant_tip_mass_does_not_collapse_the_subspace() {
    let (mesh, node) = lugged([8, 2, 2], [1.0, 0.05, 0.05]);
    let sets = lug_sets(&mesh, node);
    let bodies = one_body();
    let lump = 500.0;
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, clamped());
    p.points = lug(node, lump);
    p.couplings = vec![couple("attach", node, "xmax", CoupleKind::Distributed)];
    let modal = Step::Modal { n_modes: 6, shift: None, solver: SolveOptions::default() };
    let res = run_step(&p, &modal).expect("six modes of a tip-mass cantilever");
    assert_eq!(res.frequencies.len(), 6);
    assert!(res.frequencies.iter().all(|f| f.is_finite() && *f > 0.0), "{:?}", res.frequencies);
    assert!(res.frequencies.windows(2).all(|w| w[0] <= w[1] + 1e-9), "ascending: {:?}", res.frequencies);
    // The same model without the lump: six times the beam's own mass has to slow it right down.
    let mut bare = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, clamped());
    bare.points = lug(node, 0.0);
    bare.couplings = vec![couple("attach", node, "xmax", CoupleKind::Distributed)];
    let light = run_step(&bare, &modal).expect("the same beam without the mass");
    assert!(
        res.frequencies[0] * 4.0 < light.frequencies[0],
        "{} against {} without the mass",
        res.frequencies[0],
        light.frequencies[0]
    );
}

/// Stress is averaged over the elements meeting at a node, and a point mass has none: it takes
/// zero rather than indexing an empty adjacency.
#[test]
fn stress_averaging_gives_a_point_mass_zero() {
    let (mesh, node) = lugged([1, 1, 1], [1.5, 0.2, 0.05]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    let u: Vec<f64> = (0..p.n_dofs()).map(|i| 1e-4 * ((i % 7) as f64 - 3.0)).collect();
    let (gp, _) = stress_gp(&p, &u).expect("the block recovers");
    let nodal = average_at_nodes(&p, &gp_to_nodes(&mesh, &gp));
    assert_eq!(nodal.len(), mesh.n_nodes());
    for c in 0..nodal.comps {
        assert_eq!(nodal.data[node as usize * nodal.comps + c], 0.0, "no element, no stress");
    }
    assert!(nodal.data[..VOIGT].iter().any(|v| v.abs() > 0.0), "the block itself is stressed");
}

// ---------------------------------------------------------------------------------------------
// Thermal contact resistance (#85). `contact.thermal` replaces a bonded contact's perfect
// thermal tie with a finite conductance, assembled directly into `K` rather than eliminated.

/// `Csr::add_at` is the direct-write half of thermal contact assembly: it finds the entry
/// `pattern_coupled` promised and adds into it, wherever the row happens to put it, rather than
/// going through the element scatter's slot map.
#[test]
fn csr_add_at_writes_the_entry_the_pattern_promised() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
    let pat = pattern_coupled(&mesh, 1, &[[0, 5]]);
    let mut k = pat.csr;
    k.add_at(0, 5, 3.0);
    k.add_at(0, 5, 1.0);
    k.add_at(5, 0, -2.0);
    let entry = |k: &Csr, r: u32, c: u32| {
        let (lo, hi) = (k.row_ptr[r as usize] as usize, k.row_ptr[r as usize + 1] as usize);
        let at = k.col_idx[lo..hi].binary_search(&c).expect("the extra pair seeded this entry");
        k.vals[lo + at]
    };
    assert_eq!(entry(&k, 0, 5), 4.0, "repeated adds accumulate");
    assert_eq!(entry(&k, 5, 0), -2.0, "the two triangles are independent entries");
    assert_eq!(entry(&k, 0, 0), 0.0, "add_at never touches an entry it was not asked for");
}

/// `mpc::build` excludes the rows of a contact a `contact.thermal` load names, so the perfect
/// tie and the finite resistance are never both applied — but only on the heat DOF: the very
/// same Coupling read by a structural Problem still produces an ordinary eliminated tie, because
/// a `HeatLoad::Contact` never reaches a Problem whose unknown is displacement.
#[test]
fn a_thermal_contact_load_excludes_its_tie_from_elimination_but_only_for_heat() {
    let mesh = two_blocks(ElementKind::Hex8, [1, 1, 1], [1, 1, 1], [1.0, 1.0, 1.0], 0.0);
    let sets = sets_of(&mesh);
    let bodies = two_bodies();
    let mut p = heat_problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        conductor(45.0, 7800.0, 460.0),
        vec![hold("cold", "a.xmin", 300.0), hold("hot", "b.xmax", 400.0)],
        vec![HeatLoad::Contact { of: "weld".into(), h: 500.0 }],
    );
    p.couplings = vec![bond(1e-9)];
    let m = mpc::build(&p).expect("the pairing still runs; only its destination changes");
    assert!(m.rows.is_empty(), "the tie is excluded, not eliminated: {:?}", m.rows);
    assert!(m.slaves.is_empty());
    assert_eq!(m.contact.len(), 4, "one row per node of the shared 1x1 face");
    for row in &m.contact {
        assert_eq!(row.owner, 0);
        assert_eq!(row.masters.len(), 1, "a matched face pairs node to node");
        assert_eq!(row.masters[0].1, 1.0);
    }
    assert_eq!(
        m.contact_pairs().len(),
        4,
        "one [slave, master] pair per node; a 1:1 pairing has no master-master fill"
    );

    // The identical Coupling and an (unrealistic, but not our business to forbid) leftover
    // `HeatLoad::Contact` on a structural Problem: `p.heat` being false is what keeps the
    // mechanical tie untouched, not the absence of the heat Load.
    let mut sp = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    sp.couplings = vec![bond(1e-9)];
    sp.heat_loads = vec![HeatLoad::Contact { of: "weld".into(), h: 500.0 }];
    let sm = mpc::build(&sp).expect("a structural Problem ignores heat_loads for the skip check");
    assert_eq!(sm.rows.len(), 12, "4 nodes * 3 components: the mechanical tie is unaffected");
    assert!(sm.contact.is_empty());
}

/// `checks::all` refuses a `contact.thermal` whose `of` names a contact this Step's constraints
/// do not list — the `model.ill-posed` the doc string promises, and what keeps `heat::assemble`'s
/// `of` → Coupling lookup total.
#[test]
fn checks_refuse_a_thermal_contact_naming_a_contact_outside_the_step() {
    let mesh = two_blocks(ElementKind::Hex8, [1, 1, 1], [1, 1, 1], [1.0, 1.0, 1.0], 0.0);
    let sets = sets_of(&mesh);
    let bodies = two_bodies();
    let mut p = heat_problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        conductor(45.0, 7800.0, 460.0),
        vec![hold("cold", "a.xmin", 300.0), hold("hot", "b.xmax", 400.0)],
        vec![HeatLoad::Contact { of: "nope".into(), h: 500.0 }],
    );
    p.couplings = vec![bond(1e-9)];
    let e = checks::all(&p).into_iter().find(|e| e.code == ErrorCode::ModelIllPosed).expect("caught");
    assert!(e.cause.contains("'nope'"), "{}", e.cause);
    assert_eq!(e.where_.as_deref(), Some("contact 'nope'"));
    let refused = run_step(&p, &steady()).expect_err("the checks catch it first");
    assert_eq!(refused.code, ErrorCode::ModelIllPosed);

    // Naming the contact this Step really does list is not an error.
    p.heat_loads = vec![HeatLoad::Contact { of: "weld".into(), h: 500.0 }];
    assert!(checks::all(&p).is_empty(), "{:?}", checks::all(&p));
}

/// Benchmark F4e: `contact.thermal` reproduces the closed form of two conductors in series with
/// a finite interface resistance, `q = ΔT / (L1/k1 + 1/hc + L2/k2)`, with a temperature jump of
/// exactly `q/hc` at the interface. Two independent Bodies of different conductivity, tied by
/// `contact.add` and overridden by `contact.thermal`, against an oracle no part of the engine
/// supplies.
#[test]
fn f4e_a_finite_interface_conductance_matches_the_series_resistance_closed_form() {
    let (k1, k2, hc) = (10.0, 20.0, 500.0);
    let (l1, l2) = (0.4, 0.6);
    let (side, area) = (0.1, 0.1 * 0.1);
    let (t_cold, t_hot) = (300.0, 400.0);
    let a = Structured { kind: ElementKind::Hex8, n: [4, 1, 1] }.box_([l1, side, side]);
    let b = Structured { kind: ElementKind::Hex8, n: [6, 1, 1] }.box_([l2, side, side]);
    let mesh = join(&a, &b, [l1, 0.0, 0.0]);
    let sets = sets_of(&mesh);
    let bodies = two_bodies();
    let p = Problem {
        mesh: &mesh,
        sets: &sets,
        body_of_block: &bodies,
        material_of_block: vec![Some(0), Some(1)],
        materials: vec![conductor(k1, 1.0, 1.0), conductor(k2, 1.0, 1.0)],
        section_of_block: vec![None, None],
        sections: Vec::new(),
        idealisation: Idealisation::Solid3d,
        formulation: Formulation::Full,
        constraints: vec![hold("cold", "a.xmin", t_cold), hold("hot", "b.xmax", t_hot)],
        couplings: vec![bond(1e-9)],
        points: Vec::new(),
        loads: Vec::new(),
        temperature: None,
        heat: true,
        heat_loads: vec![HeatLoad::Contact { of: "weld".into(), h: hc }],
    };
    assert!(checks::all(&p).is_empty(), "{:?}", checks::all(&p));
    let res = run_step(&p, &steady()).expect("a well-posed series-resistance conduction problem");
    assert!(res.warnings.is_empty(), "a matched, closed interface warns about nothing: {:?}", res.warnings);

    // The independent oracle: series thermal resistance, and the jump it implies at the
    // interface. Nothing here is computed by the engine.
    let r_total = l1 / k1 + 1.0 / hc + l2 / k2;
    let q = (t_hot - t_cold) / r_total;
    let t_master = t_cold + q * l1 / k1; // the master (cold-side) face of the tie, x = l1
    let t_slave = t_master + q / hc; // the slave (hot-side) face, across the resistance
    assert!((t_hot - (t_slave + q * l2 / k2)).abs() <= 1e-9 * t_hot, "the oracle itself closes");

    // Two distinct nodes share the coordinate x = l1 — one on each side of the interface — so
    // the check is split by body, not by x: that coincidence is exactly the physics under test.
    let temperature = temperature_of(&res);
    let na = a.n_nodes() as u32;
    for node in 0..na {
        let x = mesh.node(node)[0];
        let want = t_cold + q * x / k1;
        let got = temperature[node as usize];
        assert!((got - want).abs() <= 1e-9 * t_hot, "body a, node {node} at x={x}: got {got}, want {want}");
    }
    for node in na..mesh.n_nodes() as u32 {
        let x = mesh.node(node)[0] - l1;
        let want = t_slave + q * x / k2;
        let got = temperature[node as usize];
        assert!((got - want).abs() <= 1e-9 * t_hot, "body b, node {node} at local x={x}: got {got}, want {want}");
    }

    // The engine's own master and slave nodes, found unambiguously in each Body's own mesh
    // rather than by their shared global coordinate, reproduce the closed-form jump exactly.
    let master_node = node_at(&a, [l1, 0.0, 0.0]);
    let slave_node = na + node_at(&b, [0.0, 0.0, 0.0]);
    let (got_master, got_slave) = (temperature[master_node as usize], temperature[slave_node as usize]);
    assert!((got_master - t_master).abs() <= 1e-9 * t_hot, "master node: got {got_master}, want {t_master}");
    assert!((got_slave - t_slave).abs() <= 1e-9 * t_hot, "slave node: got {got_slave}, want {t_slave}");
    assert!(
        (got_slave - got_master - q / hc).abs() <= 1e-9 * q,
        "the interface jump is exactly q / hc: got {}, want {}",
        got_slave - got_master,
        q / hc
    );

    // The total flux crosses every cross-section unchanged, including the resistance itself,
    // and the two held ends carry it in and out with nothing left over.
    let flow: Vec<f64> = res.reactions.iter().map(|(_, r)| r[0]).collect();
    assert!((flow[0] - q * area).abs() <= 1e-9 * q * area, "the cold end removes q*A: {flow:?}");
    assert!((flow[0] + flow[1]).abs() <= 1e-9 * q * area, "and the hot end supplies exactly that much");
    assert!((res.scalars["applied_total_x"]).abs() <= 1e-12, "no source or film: nothing is externally applied");

    // The tie is not a support: the interface reports no reaction of its own.
    assert!(res.reactions.iter().all(|(name, _)| name != "weld"));
}

// ---------------------------------------------------------------------------------------------
// Radiation (#79). The Stefan-Boltzmann constant is repeated here on purpose: a test that read
// it from the engine would agree with the engine by construction.
const SIGMA: f64 = 5.670_374_419e-8;

/// The bits `face_integrals` produced on a distorted hex8 face before the convection and
/// radiation integrals were merged into `face_film`, captured from the previous implementation.
/// Index and value; every other entry was exactly zero.
const CONVECTION_MAT_BITS: [(usize, u64); 16] = [
    (9, 4600136902572446901),
    (10, 4595601230127101423),
    (13, 4595429395609894819),
    (14, 4590893701533684511),
    (17, 4595601230127101423),
    (18, 4600072756936496938),
    (21, 4590893701533684510),
    (22, 4595365206712215196),
    (41, 4595429395609894820),
    (42, 4590893701533684510),
    (45, 4599729087902083732),
    (46, 4595193372195008592),
    (49, 4590893701533684511),
    (50, 4595365206712215196),
    (53, 4595193372195008592),
    (54, 4599664855742674446),
];
const CONVECTION_VEC_BITS: [(usize, u64); 4] =
    [(1, 4605360167270343204), (2, 4605312047227948316), (5, 4605054295452138411), (6, 4605006132148013862)];

/// The eight corners of the distorted hex the captured bits came from.
const FILM_COORDS: [f64; 24] = [
    0.0, 0.0, 0.0, 1.3, 0.1, -0.2, 1.1, 1.7, 0.3, 0.2, 1.4, 0.05, 0.05, -0.1, 2.1, 1.4, 0.2, 1.9, 1.2, 1.6, 2.3, 0.1,
    1.5, 2.0,
];

/// Generalising the convection face integral into `face_film` changed no number: the constant
/// film reproduces the captured bits exactly, and it still does when the temperature field it is
/// handed is wildly non-zero, because a constant film reads the temperature and ignores it.
#[test]
fn a_constant_film_reproduces_the_convection_face_integral_bit_for_bit() {
    let material = conductor(45.0, 7800.0, 460.0);
    let c = ElementCtx {
        coords: &FILM_COORDS,
        material: &material,
        section: None,
        idealisation: Idealisation::Solid3d,
        formulation: Formulation::IncompatibleModes,
        temperature: None,
        t_ref: 0.0,
    };
    let mut mat = vec![0.0; 64];
    let mut load = vec![0.0; 8];
    femlab_engine::fem::heat::face_integrals(ElementKind::Hex8, &c, 3, &mut mat, &mut load)
        .expect("a well-shaped face");
    for &(i, bits) in &CONVECTION_MAT_BITS {
        assert_eq!(mat[i].to_bits(), bits, "mat[{i}] = {}", mat[i]);
    }
    for &(i, bits) in &CONVECTION_VEC_BITS {
        assert_eq!(load[i].to_bits(), bits, "vec[{i}] = {}", load[i]);
    }
    assert_eq!(mat.iter().filter(|v| **v != 0.0).count(), CONVECTION_MAT_BITS.len());
    assert_eq!(load.iter().filter(|v| **v != 0.0).count(), CONVECTION_VEC_BITS.len());

    let t_nodes = [301.0, 455.0, 12.0, -7.0, 900.0, 1.5, 260.0, 33.0];
    let (mut mat2, mut load2) = (vec![0.0; 64], vec![0.0; 8]);
    femlab_engine::fem::heat::face_film(ElementKind::Hex8, &c, 3, &t_nodes, &|_| (1.0, 1.0), &mut mat2, &mut load2)
        .expect("a well-shaped face");
    assert_eq!(mat2, mat);
    assert_eq!(load2, load);

    // A film that does depend on the temperature does not produce the same numbers, so the
    // bit-identity above is a statement about constant films and not about a dead argument.
    let (mut mat3, mut load3) = (vec![0.0; 64], vec![0.0; 8]);
    femlab_engine::fem::heat::face_film(ElementKind::Hex8, &c, 3, &t_nodes, &|t| (t, 2.0 * t), &mut mat3, &mut load3)
        .expect("a well-shaped face");
    assert!(mat3 != mat && load3 != load);
}

/// A radiating slab's surface temperature by bisection on `k (T0 − T_L)/L = σ ε (T_L⁴ − T∞⁴)`.
/// The whole oracle is this scalar equation; it knows nothing about finite elements.
fn radiating_slab_surface(k: f64, length: f64, t0: f64, t_inf: f64, emissivity: f64) -> f64 {
    let fourth = |t: f64| t * t * t * t;
    let residual = |t: f64| k * (t0 - t) / length - SIGMA * emissivity * (fourth(t) - fourth(t_inf));
    let (mut lo, mut hi) = (t_inf, t0);
    // 200 halvings take the bracket far below one ulp of the answer.
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        if residual(mid) > 0.0 {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

fn tight() -> NonlinearControl {
    NonlinearControl { tol: 1e-12, max_iterations: 100 }
}

/// Benchmark E6: a slab held at `T0` on one face and radiating to `T∞` from the other. The
/// steady flux is the same through every section, so the surface temperature solves a scalar
/// equation the test bisects independently; the conduction profile is linear, so quad4
/// reproduces it exactly and the answer must not move with the mesh. At convergence the heat
/// entering through the held face equals the power the surface radiates away, which is the
/// conservation oracle for the nonlinear film.
#[test]
fn a_radiating_slab_reaches_the_surface_temperature_a_bisection_predicts() {
    let (k, length, height, t0, t_inf, emissivity) = (55.6, 0.1, 0.02, 1000.0, 300.0, 0.98);
    let want = radiating_slab_surface(k, length, t0, t_inf, emissivity);
    let fourth = |t: f64| t * t * t * t;
    let mut answers = Vec::new();
    for n in [4usize, 8, 16] {
        let mesh = Structured { kind: ElementKind::Quad4, n: [n, 2, 1] }.box_([length, height, 0.0]);
        let sets = sets_of(&mesh);
        let bodies = one_body();
        let p = heat_problem(
            &mesh,
            &sets,
            &bodies,
            Idealisation::PlaneStrain,
            conductor(k, 7800.0, 460.0),
            vec![hold("hot", "xmin", t0)],
            vec![HeatLoad::Radiation { faces: "xmax".into(), emissivity, t_inf }],
        );
        let step = Step::HeatSteady { solver: SolveOptions::default(), control: tight() };
        let res = run_step(&p, &step).expect("a radiating face holds the temperature");
        let got = temperature_at(&mesh, &res, [length, 0.5 * height, 0.0]);
        assert!((got - want).abs() <= 1e-9 * want, "n = {n}: {got} against the bisection {want}");
        // The Picard passes are reported, and a fourth-power law is not solved in one.
        let passes = res.scalars["nonlinear_iterations"];
        assert!(passes > 1.0 && passes <= 100.0, "{passes} passes");
        // Conservation: heat in through the support = power radiated from the far face, whose
        // area is `height` times the unit out-of-plane thickness of a plane-strain model.
        // A Constraint's thermal reaction is the heat it *removes*, so heat entering through the
        // hot face is negative and its magnitude is the power the far face radiates away.
        let radiated = SIGMA * emissivity * (fourth(got) - fourth(t_inf)) * height;
        let through_support = -res.reactions[0].1[0];
        assert!(
            (through_support - radiated).abs() <= 1e-9 * radiated,
            "n = {n}: {through_support} W in, {radiated} W radiated"
        );
        assert!((res.scalars["applied_total_x"] + radiated).abs() <= 1e-9 * radiated);
        assert_eq!(res.scalars["storage_power"], 0.0);
        assert!((res.scalars["applied_total_x"] - res.reactions[0].1[0]).abs() <= 1e-9 * radiated);
        answers.push(got);
    }
    // A linear profile is in the quad4 space, so refining must not move the answer at all.
    assert!((answers[1] - answers[0]).abs() <= 1e-9, "{answers:?}");
    assert!((answers[2] - answers[0]).abs() <= 1e-9, "{answers:?}");
}

/// A steady Step whose boundaries are one convection face, one radiating face and a volumetric
/// source: nothing holds the temperature by Dirichlet, and the two films between them must carry
/// away exactly the heat the source puts in. Both face temperatures are uniform, so the balance
/// is closed with two closed-form face fluxes and no engine quantity on the right-hand side.
#[test]
fn a_source_between_a_convecting_and_a_radiating_face_balances_exactly() {
    let (k, length, height) = (20.0, 0.2, 0.05);
    let (h, film_t_inf, emissivity, rad_t_inf, q) = (25.0, 300.0, 0.7, 400.0, 2.0e5);
    let mesh = Structured { kind: ElementKind::Quad4, n: [8, 2, 1] }.box_([length, height, 0.0]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = heat_problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::PlaneStrain,
        conductor(k, 7800.0, 460.0),
        Vec::new(),
        vec![
            HeatLoad::Convection { faces: "xmin".into(), h, t_inf: film_t_inf },
            HeatLoad::Radiation { faces: "xmax".into(), emissivity, t_inf: rad_t_inf },
            HeatLoad::Source { bodies: vec!["bar".to_string()], q },
        ],
    );
    // The two films are the only thing holding the temperature, and that is well posed.
    assert!(checks::all(&p).is_empty(), "{:?}", checks::all(&p));
    let step = Step::HeatSteady { solver: SolveOptions::default(), control: tight() };
    let res = run_step(&p, &step).expect("two films hold the temperature");
    let cold = temperature_at(&mesh, &res, [0.0, 0.5 * height, 0.0]);
    let hot = temperature_at(&mesh, &res, [length, 0.5 * height, 0.0]);
    let fourth = |t: f64| t * t * t * t;
    let convected = h * (cold - film_t_inf) * height;
    let radiated = SIGMA * emissivity * (fourth(hot) - fourth(rad_t_inf)) * height;
    let supplied = q * length * height;
    assert!(
        (convected + radiated - supplied).abs() <= 1e-9 * supplied,
        "{convected} W + {radiated} W against {supplied} W in"
    );
}

/// The lumped closed form of a block that radiates from one face into a 0 K sink:
/// `dT/dt = −c T⁴` with `c = σ ε A / (ρ c_p V)`, so `T(t) = T0 (1 + 3 c T0³ t)^(−1/3)`.
fn radiating_block_temperature(c: f64, t0: f64, time: f64) -> f64 {
    t0 * libm::cbrt(1.0 / (1.0 + 3.0 * c * t0 * t0 * t0 * time))
}

/// One transient run of the radiating block: the relative error of its final temperature
/// against the closed form.
fn radiating_block_error(theta: f64, dt: f64, t_end: f64) -> f64 {
    // The conductivity is deliberately enormous so the block stays isothermal to 1e-7 (its
    // radiative Biot number is 6e-6) and what is left to measure is the time integrator alone.
    let (k, rho, cp, length, height, t0) = (1.0e4, 100.0, 100.0, 0.001, 0.001, 1000.0);
    let mesh = Structured { kind: ElementKind::Quad4, n: [2, 1, 1] }.box_([length, height, 0.0]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = heat_problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::PlaneStrain,
        conductor(k, rho, cp),
        Vec::new(),
        vec![HeatLoad::Radiation { faces: "xmax".into(), emissivity: 1.0, t_inf: 0.0 }],
    );
    let step = Step::HeatTransient {
        dt,
        t_end,
        theta,
        initial: t0,
        output_every: 1,
        amplitude: None,
        solver: SolveOptions::default(),
        control: NonlinearControl { tol: 1e-9, max_iterations: 50 },
    };
    let res = run_step(&p, &step).expect("a radiating face holds the temperature");
    // A / V is 1 / length for a face of the full cross-section.
    let c = SIGMA / (rho * cp * length);
    let want = radiating_block_temperature(c, t0, t_end);
    let got = temperature_at(&mesh, &res, [0.5 * length, 0.5 * height, 0.0]);
    (got - want).abs() / want
}

/// Benchmark E7: an insulated block radiating from one face into a 0 K sink cools by
/// `dT/dt = −c T⁴`, whose closed form is `T(t) = T0 (1 + 3 c T0³ t)^(−1/3)` — a fourth-power
/// oracle that no linearised film can reproduce by accident. Halving the increment must fall on
/// the θ-method's own rate: first order at θ = 1, second at θ = 0.5.
#[test]
fn a_radiating_block_follows_its_analytic_cooling_curve_at_the_theta_method_rate() {
    let t_end = 1.0;
    for (theta, floor) in [(1.0, 0.85), (0.5, 1.7)] {
        let errors: Vec<f64> = [0.02, 0.01, 0.005].iter().map(|&dt| radiating_block_error(theta, dt, t_end)).collect();
        let rate = |a: f64, b: f64| libm::log2(a / b);
        assert!(rate(errors[0], errors[1]) > floor, "theta {theta}: {errors:?}");
        assert!(rate(errors[1], errors[2]) > floor, "theta {theta}: {errors:?}");
        assert!(errors[2] < errors[1] && errors[1] < errors[0], "theta {theta}: {errors:?}");
    }
    // Crank-Nicolson at the finest increment is on the closed form to better than 0.1 %.
    assert!(radiating_block_error(0.5, 0.005, t_end) < 1e-3);
}

/// Radiation uses endpoint fourth powers, not the fourth power of the averaged temperature.
/// Direct rectangular integration of the nodal temperature increment independently checks
/// stored energy; a sparse History must retain the same last-internal-step power balance.
#[test]
fn radiative_cooling_reports_endpoint_fluxes_and_the_exact_stored_energy_rate() {
    let (length, height, rho, cp) = (0.001, 0.001, 100.0, 100.0);
    for nx in [1usize, 2, 4] {
        let mesh = Structured { kind: ElementKind::Quad4, n: [nx, 1, 1] }.box_([length, height, 0.0]);
        let sets = sets_of(&mesh);
        let bodies = one_body();
        let p = heat_problem(
            &mesh,
            &sets,
            &bodies,
            Idealisation::PlaneStrain,
            conductor(1.0e4, rho, cp),
            Vec::new(),
            vec![HeatLoad::Radiation { faces: "xmax".into(), emissivity: 1.0, t_inf: 0.0 }],
        );
        for theta in [0.5, 1.0] {
            let mut step = Step::HeatTransient {
                dt: 0.02,
                t_end: 0.06,
                theta,
                initial: 1000.0,
                output_every: 1,
                amplitude: None,
                solver: SolveOptions::default(),
                // Large conductivity keeps this block nearly isothermal but makes 1e-12
                // state-change stopping sensitive to f64 solve roundoff (Linux reached
                // 1.18e-12 after 100 passes). Stop at 1e-10 and check the actual power/energy
                // accuracy independently below; none of those physical tolerances change.
                control: NonlinearControl { tol: 1e-10, max_iterations: 100 },
            };
            let full = run_step(&p, &step).unwrap();
            let history = full.history.as_ref().unwrap();
            let old = &history.values[history.values.len() - 2];
            let new = &history.values[history.values.len() - 1];
            let dt = history.times[history.times.len() - 1] - history.times[history.times.len() - 2];
            let surface = |values: &[f64]| {
                sets["xmax"].nodes.iter().map(|&i| values[i as usize]).sum::<f64>() / sets["xmax"].nodes.len() as f64
            };
            let fourth = |t: f64| t * t * t * t;
            let applied = -SIGMA * height * ((1.0 - theta) * fourth(surface(old)) + theta * fourth(surface(new)));
            let integral = old
                .iter()
                .zip(new)
                .enumerate()
                .map(|(i, (a, b))| {
                    let x = mesh.node(i as u32)[0];
                    let adjacent = if x == 0.0 || x == length { 1.0 } else { 2.0 };
                    adjacent * (b - a)
                })
                .sum::<f64>()
                * length
                * height
                / (4.0 * nx as f64);
            let storage = rho * cp * integral / dt;
            assert!((storage - applied).abs() < 1e-6 * applied.abs(), "nx={nx}, theta={theta}: {storage} vs {applied}");
            assert!((full.scalars["applied_total_x"] - applied).abs() < 1e-8 * applied.abs());
            assert!((full.scalars["storage_power"] - storage).abs() < 1e-9 * storage.abs());
            assert!(full.reactions.is_empty());
            assert!(full.fields[&Field::Reaction].data.iter().all(|&v| v == 0.0));
            // Only endpoints are retained, but postprocessing must use the last internal old T.
            let Step::HeatTransient { output_every, .. } = &mut step else { panic!() };
            *output_every = 99;
            let sparse = run_step(&p, &step).unwrap();
            assert_eq!(sparse.history.as_ref().unwrap().times, [0.0, 0.06]);
            assert_eq!(temperature_of(&sparse), temperature_of(&full));
            assert_eq!(sparse.scalars["applied_total_x"], full.scalars["applied_total_x"]);
            assert_eq!(sparse.scalars["storage_power"], full.scalars["storage_power"]);
        }
    }
}

/// A face whose film is negative makes the system indefinite whatever the temperature, and both
/// radiating procedures let the factorisation error out rather than taking the host down with it.
/// The Command boundary refuses a negative emissivity, so only a direct Problem can get here —
/// which is exactly the malformed-extension case the linear paths already guard against.
#[test]
fn a_radiating_step_propagates_a_factorisation_failure() {
    let mesh = Structured { kind: ElementKind::Quad4, n: [2, 1, 1] }.box_([0.1, 0.02, 0.0]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = heat_problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::PlaneStrain,
        conductor(55.6, 7800.0, 460.0),
        vec![hold("hot", "xmin", 1000.0)],
        vec![HeatLoad::Radiation { faces: "xmax".into(), emissivity: -1e12, t_inf: 300.0 }],
    );
    let control = NonlinearControl::default();
    let steady_error = run_step(&p, &Step::HeatSteady { solver: SolveOptions::default(), control: control.clone() })
        .expect_err("a negative film cannot be factorised");
    assert_eq!(steady_error.code, ErrorCode::SolveNotPositiveDefinite);
    let transient = Step::HeatTransient {
        dt: 1.0,
        t_end: 1.0,
        theta: 1.0,
        initial: 300.0,
        output_every: 1,
        amplitude: None,
        solver: SolveOptions::default(),
        control,
    };
    let transient_error = run_step(&p, &transient).expect_err("a negative film cannot be factorised");
    assert_eq!(transient_error.code, ErrorCode::SolveNotPositiveDefinite);
}

/// A budget of one pass cannot converge a fourth-power film, and both radiating procedures say
/// so with the same code, a `where` that names the increment, and a suggestion.
#[test]
fn a_radiation_step_that_runs_out_of_passes_is_solve_diverged() {
    let mesh = Structured { kind: ElementKind::Quad4, n: [2, 1, 1] }.box_([0.1, 0.02, 0.0]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = heat_problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::PlaneStrain,
        conductor(55.6, 7800.0, 460.0),
        vec![hold("hot", "xmin", 1000.0)],
        vec![HeatLoad::Radiation { faces: "xmax".into(), emissivity: 0.98, t_inf: 300.0 }],
    );
    let stingy = NonlinearControl { tol: 1e-12, max_iterations: 1 };
    let steady_error = run_step(&p, &Step::HeatSteady { solver: SolveOptions::default(), control: stingy.clone() })
        .expect_err("one pass cannot converge a fourth-power film");
    assert_eq!(steady_error.code, ErrorCode::SolveDiverged);
    assert_eq!(steady_error.where_.as_deref(), Some("heat-steady"));
    assert!(steady_error.suggestion.expect("a way out").contains("nonlinearMaxIterations"));
    let transient = Step::HeatTransient {
        dt: 1.0,
        t_end: 2.0,
        theta: 1.0,
        initial: 300.0,
        output_every: 1,
        amplitude: None,
        solver: SolveOptions::default(),
        control: stingy,
    };
    let transient_error = run_step(&p, &transient).expect_err("one pass cannot converge an increment either");
    assert_eq!(transient_error.code, ErrorCode::SolveDiverged);
    assert_eq!(transient_error.where_.as_deref(), Some("heat-transient increment 1"));
}

/// Exact integral of a trilinear field over this test's axis-aligned Hex8 cells: each corner
/// owns one eighth of its cell volume. This does not call capacity or any FE quadrature.
fn box_temperature_integral(mesh: &Mesh, values: &[f64]) -> f64 {
    (0..mesh.n_elems() as u32)
        .map(|elem| {
            let nodes = mesh.elem_nodes(elem);
            let mut lo = [f64::INFINITY; 3];
            let mut hi = [f64::NEG_INFINITY; 3];
            for &node in nodes {
                let x = mesh.node(node);
                for k in 0..3 {
                    lo[k] = lo[k].min(x[k]);
                    hi[k] = hi[k].max(x[k]);
                }
            }
            let volume = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
            nodes.iter().map(|&n| values[n as usize]).sum::<f64>() * volume / 8.0
        })
        .sum()
}

/// A tied, held interface must transfer the slave's capacity residual too. Uniform heating
/// has T=300+2t, source rho*cp*2, and zero support power, independently of the split mesh.
#[test]
fn a_held_thermal_tie_transfers_storage_and_starts_with_an_admissible_history() {
    let bodies = two_bodies();
    for nx in [1, 2, 4] {
        let mesh = two_blocks(ElementKind::Hex8, [nx, 1, 1], [nx, 1, 1], [0.5, 0.1, 0.1], 0.0);
        let sets = sets_of(&mesh);
        let mut p = heat_problem(
            &mesh,
            &sets,
            &bodies,
            Idealisation::Solid3d,
            conductor(1.0, 10.0, 2.0),
            vec![hold("interface", "a.xmax", 1.0)],
            vec![HeatLoad::Source { bodies: bodies.clone(), q: 40.0 }],
        );
        p.couplings = vec![bond(1e-9)];
        for theta in [0.5, 1.0] {
            let step = |initial| Step::HeatTransient {
                dt: 0.1,
                t_end: 0.3,
                theta,
                initial,
                output_every: 1,
                amplitude: Some(procedure::Amplitude::Table { t: vec![0.0, 0.3], value: vec![300.0, 300.6] }),
                solver: SolveOptions::default(),
                control: NonlinearControl::default(),
            };
            let res = run_step(&p, &step(300.0)).unwrap();
            for t in temperature_of(&res) {
                assert!((t - 300.6).abs() < 1e-8, "nx={nx}, theta={theta}: {t}");
            }
            assert!((res.scalars["applied_total_x"] - 0.4).abs() < 1e-10);
            assert!((res.scalars["storage_power"] - 0.4).abs() < 1e-9);
            assert!(res.reactions[0].1[0].abs() < 1e-9, "the held interface supplies no heat to the uniform ramp");
            // Deliberately give free nodes a different initial temperature. The held master
            // and its slave must agree before the very first capacity/radiation evaluation.
            let res = run_step(&p, &step(299.0)).unwrap();
            let h = res.history.as_ref().unwrap();
            for &node in &sets["b.xmin"].nodes {
                assert!((h.values[0][node as usize] - 300.0).abs() < 1e-10);
            }
            let last = h.values.len() - 1;
            let storage = 20.0
                * (box_temperature_integral(&mesh, &h.values[last])
                    - box_temperature_integral(&mesh, &h.values[last - 1]))
                / (h.times[last] - h.times[last - 1]);
            assert!((res.scalars["storage_power"] - storage).abs() < 1e-9);
            assert!((0.4 - res.reactions[0].1[0] - storage).abs() < 1e-8);
        }
    }
}

/// Radiation crosses a perfect contact with the same steady scalar flux law. During cooling,
/// the weighted endpoint surface flux equals the full two-body stored-energy rate.
#[test]
fn a_thermal_tie_preserves_radiation_endpoint_power_and_whole_body_storage() {
    let bodies = two_bodies();
    let (length, area, k, rho_cp) = (0.1, 0.0004, 55.6, 10_000.0);
    for nx in [1, 2, 4] {
        let mesh = two_blocks(ElementKind::Hex8, [nx, 1, 1], [nx, 1, 1], [0.05, 0.02, 0.02], 0.0);
        let sets = sets_of(&mesh);
        let mut p = heat_problem(
            &mesh,
            &sets,
            &bodies,
            Idealisation::Solid3d,
            conductor(k, 100.0, 100.0),
            vec![hold("hot", "a.xmin", 1000.0)],
            vec![HeatLoad::Radiation { faces: "b.xmax".into(), emissivity: 1.0, t_inf: 0.0 }],
        );
        p.couplings = vec![bond(1e-9)];
        let surface = radiating_slab_surface(k, length, 1000.0, 0.0, 1.0);
        let outgoing = SIGMA * area * surface.powi(4);
        let res = run_step(&p, &steady()).unwrap();
        assert!((res.scalars["applied_total_x"] + outgoing).abs() < 1e-7 * outgoing);
        assert!((res.reactions[0].1[0] + outgoing).abs() < 1e-7 * outgoing);
        p.constraints.clear();
        for theta in [0.5, 1.0] {
            let step = Step::HeatTransient {
                dt: 0.1,
                t_end: 0.3,
                theta,
                initial: 1000.0,
                output_every: 1,
                amplitude: None,
                solver: SolveOptions::default(),
                control: NonlinearControl { tol: 1e-10, max_iterations: 100 },
            };
            let res = run_step(&p, &step).unwrap();
            let h = res.history.as_ref().unwrap();
            let last = h.values.len() - 1;
            let mean_surface = |values: &[f64]| {
                sets["b.xmax"].nodes.iter().map(|&n| values[n as usize]).sum::<f64>()
                    / sets["b.xmax"].nodes.len() as f64
            };
            let applied = -SIGMA
                * area
                * ((1.0 - theta) * mean_surface(&h.values[last - 1]).powi(4)
                    + theta * mean_surface(&h.values[last]).powi(4));
            let storage = rho_cp
                * (box_temperature_integral(&mesh, &h.values[last])
                    - box_temperature_integral(&mesh, &h.values[last - 1]))
                / (h.times[last] - h.times[last - 1]);
            assert!((res.scalars["applied_total_x"] - applied).abs() < 1e-8 * applied.abs());
            assert!((res.scalars["storage_power"] - storage).abs() < 1e-9 * storage.abs());
            assert!((storage - applied).abs() < 1e-7 * applied.abs(), "nx={nx}, theta={theta}");
            assert!(res.reactions.is_empty());
        }
    }
}

// ---------------------------------------------------------------- STL reading (#350)

/// The same triangles as `write_stl` writes, packed as a binary STL.
fn binary_stl(positions: &[[f64; 3]], triangles: &[[u32; 3]]) -> Vec<u8> {
    let mut out = vec![0u8; 80];
    out.extend_from_slice(&(triangles.len() as u32).to_le_bytes());
    for t in triangles {
        out.extend_from_slice(&[0u8; 12]); // facet normal: ignored on the way back in
        for v in t {
            for c in positions[*v as usize] {
                out.extend_from_slice(&(c as f32).to_le_bytes());
            }
        }
        out.extend_from_slice(&[0u8; 2]); // attribute byte count
    }
    out
}

#[test]
fn stl_reads_back_exactly_what_it_wrote_for_every_primitive() {
    let shapes = [
        Shape::Box { size: [1.0, 2.0, 3.0] },
        Shape::Cylinder { radius: 1.0, height: 2.0, segments: Some(32) },
        Shape::Sphere { radius: 1.0, segments: Some(16) },
        Shape::Revolve { sketch: Sketch::rect(1.0, 2.0), angle: 360.0, segments: Some(24) },
    ];
    for shape in shapes {
        let solid = Solid::evaluate(&shape).unwrap();
        let tri = solid.triangles();
        let (positions, triangles) = read_stl(write_stl(tri, "part").as_bytes()).unwrap();
        // the writer prints f64 losslessly and the reader welds on exact bits, so the mesh
        // comes back with the same vertices and the same connectivity, only renumbered
        assert_eq!(positions.len(), tri.positions.len(), "{shape:?}");
        assert_eq!(triangles.len(), tri.triangles.len(), "{shape:?}");
        let same = |t: &[u32; 3], p: &[[f64; 3]]| [p[t[0] as usize], p[t[1] as usize], p[t[2] as usize]];
        for (a, b) in triangles.iter().zip(&tri.triangles) {
            assert_eq!(same(a, &positions), same(b, &tri.positions), "{shape:?}");
        }
    }
}

// ------------------------------------------- geometric nonlinearity (issue #59, plan G)

/// `det` of a 3×3, written out here so the oracle does not borrow the kernel's own.
fn det3x3(f: [[f64; 3]; 3]) -> f64 {
    f[0][0] * (f[1][1] * f[2][2] - f[1][2] * f[2][1]) - f[0][1] * (f[1][0] * f[2][2] - f[1][2] * f[2][0])
        + f[0][2] * (f[1][0] * f[2][1] - f[1][1] * f[2][0])
}

fn matmul3(a: [[f64; 3]; 3], b: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut c = [[0.0; 3]; 3];
    for (i, row) in c.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    c
}

fn rot_z(a: f64) -> [[f64; 3]; 3] {
    [[libm::cos(a), -libm::sin(a), 0.0], [libm::sin(a), libm::cos(a), 0.0], [0.0, 0.0, 1.0]]
}

fn rot_x(a: f64) -> [[f64; 3]; 3] {
    [[1.0, 0.0, 0.0], [0.0, libm::cos(a), -libm::sin(a)], [0.0, libm::sin(a), libm::cos(a)]]
}

/// What a St Venant–Kirchhoff material answers a homogeneous deformation `F` with: the
/// Green–Lagrange strain, the second Piola–Kirchhoff stress, and the Cauchy stress they push
/// forward to. `E = ½(FᵀF − I)` and `σ = F S Fᵀ / det F` are definitions, so this is the
/// closed form of the whole finite-strain chain and not a second implementation of it.
fn svk(f: [[f64; 3]; 3]) -> ([f64; VOIGT], [f64; VOIGT]) {
    let c = |i: usize, j: usize| (0..3).map(|k| f[k][i] * f[k][j]).sum::<f64>();
    let e = [0.5 * (c(0, 0) - 1.0), 0.5 * (c(1, 1) - 1.0), 0.5 * (c(2, 2) - 1.0), c(0, 1), c(0, 2), c(1, 2)];
    let d = isotropic_d(YOUNG, POISSON);
    let mut s = [0.0; VOIGT];
    for (i, si) in s.iter_mut().enumerate() {
        *si = (0..VOIGT).map(|j| d[i][j] * e[j]).sum();
    }
    let s3 = [[s[0], s[3], s[4]], [s[3], s[1], s[5]], [s[4], s[5], s[2]]];
    let det = det3x3(f);
    let mut sigma = [0.0; VOIGT];
    for (slot, (i, j)) in [(0, 0), (1, 1), (2, 2), (0, 1), (0, 2), (1, 2)].into_iter().enumerate() {
        sigma[slot] = (0..3).map(|k| (0..3).map(|l| f[i][k] * s3[k][l] * f[j][l]).sum::<f64>()).sum::<f64>() / det;
    }
    (e, sigma)
}

/// `u = (F − I)·X` at every node: a homogeneous deformation as a nodal displacement field.
fn homogeneous_field(mesh: &Mesh, f: [[f64; 3]; 3]) -> Vec<f64> {
    let mut v = vec![0.0; mesh.n_nodes() * mesh.dim];
    for n in 0..mesh.n_nodes() {
        let x = mesh.node(n as u32);
        for i in 0..mesh.dim {
            v[n * mesh.dim + i] = (0..3).map(|j| f[i][j] * x[j]).sum::<f64>() - x[i];
        }
    }
    v
}

/// A triaxial stretch, a simple shear, a finite rotation and — in 3D — a general deformation
/// with all nine components populated.
fn homogeneous_deformations(dim: usize) -> Vec<[[f64; 3]; 3]> {
    let mut all = vec![
        [[1.2, 0.0, 0.0], [0.0, 0.95, 0.0], [0.0, 0.0, 1.0]],
        [[1.0, 0.15, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        rot_z(0.4),
    ];
    if dim == 3 {
        all.push([[1.05, 0.1, 0.03], [0.0, 0.9, 0.08], [0.02, 0.0, 1.1]]);
    }
    all
}

/// Every boundary node prescribed to an exact field, as one Constraint per node and component.
/// A Set-based Constraint carries one value, so a field that varies with position needs one
/// Set per node — which is also what makes this exercise `resolve` and the reaction grouping.
fn prescribe_field(mesh: &Mesh, sets: &mut BTreeMap<String, ResolvedSet>, exact: &[f64]) -> Vec<Constraint> {
    let mut nodes: Vec<u32> = mesh.boundary_faces().iter().flat_map(|&f| mesh.face_nodes(f)).collect();
    nodes.sort_unstable();
    nodes.dedup();
    let mut constraints = Vec::new();
    for &n in &nodes {
        let set = format!("node{n}");
        sets.insert(
            set.clone(),
            ResolvedSet { kind: SetKind::Node, faces: Vec::new(), nodes: vec![n], elems: Vec::new() },
        );
        for c in 0..mesh.dim {
            let mut dofs = [false; 3];
            dofs[c] = true;
            constraints.push(Constraint {
                name: format!("{set}.{c}"),
                nodes: set.clone(),
                dofs,
                value: exact[n as usize * mesh.dim + c],
            });
        }
    }
    constraints
}

fn nl_options(increments: usize) -> NlOptions {
    NlOptions {
        increments,
        converge: NlConverge { tolerance: 1e-8, max_newton: 20 },
        max_cutbacks: 5,
        t_end: 1.0,
        amplitude: None,
        solver: SolveOptions::default(),
    }
}

fn run_nonlinear(p: &Problem<'_>, o: NlOptions, progress: OnProgress<'_>) -> Result<StepResult, Error> {
    let step = Step::StaticNonlinear(o);
    pollster::block_on(procedure::run(p, &step, &Pool::new(2), None, None, progress))
}

/// The idealisation `static-nonlinear` runs a kind under: 3D solids as themselves, sheets as
/// plane strain, which is the one two-dimensional idealisation whose `F₃₃ = 1` this kernel has.
fn nl_idealisation(kind: ElementKind) -> Idealisation {
    if kind.dim() == 3 {
        Idealisation::Solid3d
    } else {
        Idealisation::PlaneStrain
    }
}

/// The tangent, internal force, Cauchy stress and Green–Lagrange strain of one element.
type ElementAnswer = (Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>);

/// One element's finite-strain answer at a nodal displacement.
fn element_tangent(kind: ElementKind, c: &ElementCtx<'_>, u: &[f64]) -> Result<ElementAnswer, Error> {
    let el = element_for(kind);
    let (nd, n_gp) = (el.n_dof(), el.n_gp());
    let (mut k, mut f) = (vec![0.0; nd * nd], vec![0.0; nd]);
    let (mut stress, mut strain) = (vec![0.0; n_gp * VOIGT], vec![0.0; n_gp * VOIGT]);
    let mut state = vec![0.0; n_gp * c.material.law.n_state()];
    let out = TangentOut { k: &mut k, f: &mut f, stress: &mut stress, strain: &mut strain, state: &mut state };
    el.tangent_and_force(c, u, &vec![0.0; n_gp * c.material.law.n_state()], out)?;
    Ok((k, f, stress, strain))
}

/// N3: every element kind reproduces a homogeneous finite deformation exactly on a distorted
/// mesh — the interior displacements, the Green–Lagrange strain and the Cauchy stress. A
/// formulation that dropped any term of `B_L` or of the geometric stiffness fails this.
#[test]
fn the_finite_deformation_patch_test_passes_for_every_kind() {
    for kind in ALL_KINDS {
        let mesh = patch_mesh(kind);
        let bodies = vec!["patch".to_string()];
        for f in homogeneous_deformations(kind.dim()) {
            let mut sets = sets_of(&mesh);
            let exact = homogeneous_field(&mesh, f);
            let constraints = prescribe_field(&mesh, &mut sets, &exact);
            let p = problem(&mesh, &sets, &bodies, nl_idealisation(kind), Formulation::IncompatibleModes, constraints);
            let res = run_nonlinear(&p, nl_options(2), &mut nop).expect("the finite-strain patch converges");
            let (e, sigma) = svk(f);
            let scale = exact.iter().fold(0.0f64, |m, x| m.max(x.abs()));
            let u = &res.fields[&Field::Displacement];
            let stress = &res.fields[&Field::Stress];
            let strain = &res.fields[&Field::Strain];
            for n in 0..mesh.n_nodes() {
                for c in 0..mesh.dim {
                    let (got, want) = (u.data[n * 3 + c], exact[n * mesh.dim + c]);
                    assert!((got - want).abs() <= 1e-9 * scale, "{kind:?} node {n} component {c}: {got} vs {want}");
                }
                for i in 0..VOIGT {
                    let got = stress.data[n * VOIGT + i];
                    assert!(
                        (got - sigma[i]).abs() <= 1e-8 * YOUNG,
                        "{kind:?} node {n} Cauchy component {i}: {got} vs {}",
                        sigma[i]
                    );
                    let got = strain.data[n * VOIGT + i];
                    assert!((got - e[i]).abs() <= 1e-11, "{kind:?} node {n} strain component {i}: {got} vs {}", e[i]);
                }
            }
            // Enhanced modes are switched off under finite deformation, and the Result says so
            // for exactly the two kinds that would otherwise have used them.
            let locks = matches!(kind, ElementKind::Hex8 | ElementKind::Quad4);
            assert_eq!(res.warnings.len(), usize::from(locks), "{kind:?}: {:?}", res.warnings);
            // A finite rotation applied as a linear ramp squashes the body at half a turn, and
            // St Venant–Kirchhoff softens under that much compression — so some of these
            // deformations are reached by cutting back, which is the point of the cutback.
            assert!(res.scalars["increments_taken"] >= 2.0, "{kind:?} {:?}", res.scalars);
            assert_eq!(res.scalars["load_factor"], 1.0);
            assert_eq!(res.solver.solver, "cpu-direct");
        }
    }
}

#[test]
fn stl_reads_binary_by_its_declared_facet_count() {
    let solid = Solid::evaluate(&Shape::Box { size: [1.0, 2.0, 3.0] }).unwrap();
    let tri = solid.triangles();
    let bytes = binary_stl(&tri.positions, &tri.triangles);
    assert_eq!(bytes.len(), 84 + 50 * 12);
    let (positions, triangles) = read_stl(&bytes).unwrap();
    assert_eq!(positions.len(), 8);
    assert_eq!(triangles.len(), 12);
    // f32 coordinates, so the box is exact only because 1, 2 and 3 are exact in f32
    let (lo, hi) = positions.iter().fold(([f64::MAX; 3], [f64::MIN; 3]), |(mut lo, mut hi), p| {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
        (lo, hi)
    });
    assert_eq!((lo, hi), ([0.0; 3], [1.0, 2.0, 3.0]));
    // a header whose facet count does not match the length is read as text and refused
    let mut lying = bytes.clone();
    lying[80] = 99;
    assert!(read_stl(&lying).unwrap_err().cause.contains("neither a binary STL"));
}

#[test]
fn stl_welds_repeated_vertices_and_treats_minus_zero_as_zero() {
    let text = "solid t\n\
        facet normal 0 0 0 outer loop vertex 0 0 0 vertex 1 0 0 vertex 0 1 0 endloop endfacet\n\
        facet normal 0 0 0 outer loop vertex -0.0 -0.0 -0.0 vertex 1 0 0 vertex 0 0 1 endloop endfacet\n\
        facet normal 0 0 0 outer loop vertex 0 0 0 vertex 0 1 0 vertex 0 0 1 endloop endfacet\n\
        facet normal 0 0 0 outer loop vertex 1 0 0 vertex 0 1 0 vertex 0 0 1 endloop endfacet\n\
        endsolid t\n";
    let (positions, triangles) = read_stl(text.as_bytes()).unwrap();
    assert_eq!(positions.len(), 4, "{positions:?}");
    assert_eq!(triangles.len(), 4);
    assert_eq!(positions[0], [0.0; 3]);
    // and VERTEX in any case is still a vertex
    let (upper, _) = read_stl(text.to_uppercase().as_bytes()).unwrap();
    assert_eq!(upper.len(), 4);
}

#[test]
fn stl_refuses_every_way_a_file_can_be_broken() {
    let cause = |bytes: &[u8]| read_stl(bytes).unwrap_err().cause;
    assert_eq!(read_stl(b"").unwrap_err().code, ErrorCode::Schema);
    assert!(cause(b"").contains("holds no triangles"));
    assert!(cause(b"solid empty\nendsolid empty\n").contains("holds no triangles"));
    assert!(cause(b"vertex 0 0 0 vertex 1 0 0").contains("ends in the middle of a facet"));
    assert!(cause(b"vertex 0 0").contains("ends before its three coordinates"));
    assert!(cause(b"vertex 0 0 nope").contains("'nope' is not a number (vertex coordinate 2)"));
    // not UTF-8 and not a binary STL either
    assert!(cause(&[0xff, 0xfe, 0x00, 0x01]).contains("neither a binary STL"));
    let err = read_stl(b"solid x\n").unwrap_err();
    assert_eq!(err.where_.as_deref(), Some("data"));
    assert!(err.suggestion.is_some());
}

#[test]
fn base64_round_trips_and_refuses_what_is_not_base64() {
    for n in 0..8usize {
        let bytes: Vec<u8> = (0..n).map(|i| (i * 37 + 11) as u8).collect();
        let text = base64(&bytes);
        assert_eq!(text.len() % 4, 0);
        assert_eq!(base64_decode(&text).unwrap(), bytes, "{n} bytes");
    }
    assert_eq!(base64_decode("QUJD").unwrap(), b"ABC");
    // whitespace is skipped, so a wrapped payload still reads
    assert_eq!(base64_decode("QU\nJD\n").unwrap(), b"ABC");
    assert_eq!(base64_decode("QQ==").unwrap(), b"A");
    assert_eq!(base64_decode("QUI=").unwrap(), b"AB");
    assert_eq!(base64_decode(""), Some(vec![]));
    assert_eq!(base64_decode("QUJ$"), None, "a character outside the alphabet");
    assert_eq!(base64_decode("Q"), None, "one leftover character is not a byte");
    assert_eq!(base64_decode("QQ=A"), None, "data after the padding");
    assert_eq!(base64_decode("QUJD="), None, "padding that does not complete a quantum");
    assert_eq!(base64_decode("QQ==="), None, "three pad characters");
}

/// N4: a rigid-body motion leaves no strain, no stress and no internal force, at any rotation
/// angle. A small-strain formulation fails this outright, so it is the sharpest single check
/// that the kernels really are total Lagrangian.
#[test]
fn a_rigid_body_motion_leaves_no_stress_and_no_internal_force() {
    for kind in ALL_KINDS {
        let coords = distorted(kind);
        let mat = steel();
        let dim = kind.dim();
        let cx = ctx(&coords, &mat, nl_idealisation(kind), Formulation::IncompatibleModes);
        let mut motions = vec![rot_z(0.5 * PI), rot_z(PI), rot_z(0.37)];
        if dim == 3 {
            motions.push(matmul3(rot_z(1.1), rot_x(2.0)));
        }
        for r in motions {
            let t = [0.3, -0.2, if dim == 3 { 0.45 } else { 0.0 }];
            let mut u = vec![0.0; kind.n_nodes() * dim];
            for a in 0..kind.n_nodes() {
                let x = [coords[3 * a], coords[3 * a + 1], coords[3 * a + 2]];
                for i in 0..dim {
                    u[dim * a + i] = (0..3).map(|j| r[i][j] * x[j]).sum::<f64>() + t[i] - x[i];
                }
            }
            let (_, f, stress, strain) =
                element_tangent(kind, &cx, &u).expect("a rigid motion never inverts an element");
            for v in &strain {
                assert!(v.abs() <= 1e-12, "{kind:?}: Green–Lagrange strain {v} under a rigid motion");
            }
            for v in &stress {
                assert!(v.abs() <= 1e-9 * YOUNG, "{kind:?}: Cauchy stress {v} under a rigid motion");
            }
            for v in &f {
                assert!(v.abs() <= 1e-9 * YOUNG, "{kind:?}: internal force {v} under a rigid motion");
            }
        }
    }
}

/// The consistent tangent is the derivative of the internal force: `K_T v` reproduces the
/// central difference of `f_int` along `v`. That is calculus applied to the kernels rather than
/// a second implementation of them (ADR 0007), and it is what makes Newton quadratic.
#[test]
fn the_finite_strain_tangent_is_the_derivative_of_the_internal_force() {
    for kind in ALL_KINDS {
        let coords = distorted(kind);
        let mat = steel();
        let cx = ctx(&coords, &mat, nl_idealisation(kind), Formulation::Full);
        let nd = element_for(kind).n_dof();
        let u0: Vec<f64> = lcg_vec(nd, 11).iter().map(|x| 0.01 * x).collect();
        let v = lcg_vec(nd, 23);
        let (k, _, _, _) = element_tangent(kind, &cx, &u0).expect("a mild displacement keeps det F positive");
        let h = 1e-6;
        let shift = |sign: f64| -> Vec<f64> { u0.iter().zip(&v).map(|(a, b)| a + sign * h * b).collect() };
        let (_, plus, _, _) = element_tangent(kind, &cx, &shift(1.0)).expect("perturbs");
        let (_, minus, _, _) = element_tangent(kind, &cx, &shift(-1.0)).expect("perturbs");
        let want: Vec<f64> = plus.iter().zip(&minus).map(|(a, b)| (a - b) / (2.0 * h)).collect();
        let scale = want.iter().fold(0.0f64, |m, x| m.max(x.abs()));
        for (i, w) in want.iter().enumerate() {
            let got: f64 = (0..nd).map(|j| k[i * nd + j] * v[j]).sum();
            assert!((got - w).abs() <= 1e-6 * scale, "{kind:?} row {i}: tangent {got} vs difference {w}");
        }
    }
}

/// At zero displacement the finite-strain tangent *is* the linear stiffness: `F = I` makes
/// `B_L` the small-strain `B` and leaves no initial stress for the geometric term.
#[test]
fn the_tangent_at_zero_displacement_is_the_linear_stiffness() {
    for kind in [ElementKind::Hex20, ElementKind::Tet4, ElementKind::Quad8] {
        let mesh = cantilever_mesh([3, 2, 2], kind);
        let sets = sets_of(&mesh);
        let bodies = vec!["bar".to_string()];
        let p = problem(&mesh, &sets, &bodies, nl_idealisation(kind), Formulation::Full, Vec::new());
        let pat = pattern(&mesh, mesh.dim);
        let linear = assemble_stiffness(&p, &pat).expect("assembles");
        let state = GpState::new(&p).expect("steel has no state");
        let nl = nonlinear::tangent(&p, &pat, &vec![0.0; p.n_dofs()], &state).expect("assembles");
        let scale = linear.k.vals.iter().fold(0.0f64, |m, x| m.max(x.abs()));
        for (a, b) in linear.k.vals.iter().zip(&nl.k.vals) {
            assert!((a - b).abs() <= 1e-12 * scale, "{kind:?}: {a} vs {b}");
        }
        // The internal force at zero displacement is zero, and the linear arm reports none.
        assert!(linear.f_int.is_empty() && linear.stress_gp.is_empty() && linear.state.values.is_empty());
        assert!(nl.f_thermal.is_empty());
        assert!(nl.f_int.iter().all(|x| x.abs() <= 1e-6));
        assert_eq!(nl.stress_gp.len(), mesh.n_elems() * element_for(kind).n_gp());
        // and the tangent is symmetric at a deformed state, as `K_mat + K_geo` must be
        let u = lcg_vec(p.n_dofs(), 5).iter().map(|x| 1e-3 * x).collect::<Vec<f64>>();
        let bent = nonlinear::tangent(&p, &pat, &u, &state).expect("assembles");
        let scale = bent.k.vals.iter().fold(0.0f64, |m, x| m.max(x.abs()));
        for r in 0..bent.k.n {
            for e in bent.k.row_ptr[r] as usize..bent.k.row_ptr[r + 1] as usize {
                let c = bent.k.col_idx[e] as usize;
                let lo = bent.k.row_ptr[c] as usize;
                let at = bent.k.col_idx[lo..bent.k.row_ptr[c + 1] as usize]
                    .binary_search(&(r as u32))
                    .expect("a structurally symmetric pattern");
                assert!((bent.k.vals[e] - bent.k.vals[lo + at]).abs() <= 1e-9 * scale, "{kind:?} ({r},{c})");
            }
        }
    }
}

/// A law that remembers: `n_state = 1`, and the state it advances to is the point's own first
/// strain component. Nothing physical — it is the smallest law that fails if the per-point
/// state is not threaded from the converged buffer, through the element, and back.
struct Remember;

impl MaterialLaw for Remember {
    fn id(&self) -> &str {
        "remember"
    }
    fn n_props(&self) -> usize {
        2
    }
    fn n_state(&self) -> usize {
        1
    }
    fn prop_names(&self) -> &[&str] {
        &["E", "nu"]
    }
    fn evaluate(&self, b: MaterialBatch<'_>, out: MaterialOut<'_>) -> Result<(), Error> {
        check_batch(self, &b, &out)?;
        let d = isotropic_d(b.props[0], b.props[1]);
        for p in 0..b.n {
            for (i, row) in d.iter().enumerate() {
                out.stress[p * VOIGT + i] = (0..VOIGT).map(|j| row[j] * b.strain[p * VOIGT + j]).sum();
                out.tangent[p * VOIGT * VOIGT + i * VOIGT..p * VOIGT * VOIGT + (i + 1) * VOIGT].copy_from_slice(row);
            }
            out.state_out[p] = b.state_in[p] + b.strain[p * VOIGT];
        }
        Ok(())
    }
}

static REMEMBER: Remember = Remember;

fn remembering() -> Material {
    Material { law: &REMEMBER, props: vec![YOUNG, POISSON], rho: DENSITY, alpha: EXPANSION, k: 45.0, cp: 460.0 }
}

/// The per-Gauss-point state buffer: sized from the law, read by the element, written back in
/// element order, and empty for every material that has no history to keep.
#[test]
fn the_gauss_point_state_is_sized_read_and_written_back() {
    let kind = ElementKind::Hex8;
    let mesh = cantilever_mesh([2, 1, 1], kind);
    let sets = sets_of(&mesh);
    let bodies = vec!["bar".to_string()];
    let n_gp = element_for(kind).n_gp();

    // A stateless Problem allocates nothing but the offsets.
    let plain = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    let empty = GpState::new(&plain).expect("steel has no state");
    assert_eq!(empty.offsets, vec![0; mesh.n_elems() + 1]);
    assert!(empty.values.is_empty() && empty.of(0).is_empty());

    // A stateful one gets `n_gp` values per element, and the element advances every one.
    let mut stateful = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    stateful.materials = vec![remembering()];
    let mut state = GpState::new(&stateful).expect("the law names its state");
    assert_eq!(state.offsets, vec![0, n_gp, 2 * n_gp]);
    assert_eq!(state.values.len(), 2 * n_gp);
    state.set(1, &vec![7.0; n_gp]);
    assert_eq!(state.of(1), vec![7.0; n_gp]);
    assert_eq!(state.of(0), vec![0.0; n_gp]);

    let pat = pattern(&mesh, mesh.dim);
    let u = homogeneous_field(&mesh, [[1.1, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);
    let advanced = nonlinear::tangent(&stateful, &pat, &u, &state).expect("assembles");
    // E₁₁ of a 10 % stretch is 0.105, added to whatever each element carried in.
    for (elem, carried) in [(0u32, 0.0), (1, 7.0)] {
        for v in advanced.state.of(elem) {
            assert!((v - (carried + 0.105)).abs() < 1e-12, "element {elem}: {v}");
        }
    }

    // and a Body without a material is the same error every other integral over it gives —
    // reported before a single element is touched, because the state buffer is sized first
    let mut bare = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    bare.material_of_block = vec![None; mesh.blocks.len()];
    assert_eq!(GpState::new(&bare).expect_err("no material").code, ErrorCode::ModelNoMaterial);
    let sized = nonlinear::tangent(&bare, &pat, &vec![0.0; bare.n_dofs()], &state).expect_err("no material");
    assert_eq!(sized.code, ErrorCode::ModelNoMaterial);
    // and the well-posedness checks run before anything is assembled at all
    let refused = run_nonlinear(&bare, nl_options(1), &mut nop).expect_err("an ill-posed Problem");
    assert_eq!(refused.code, ErrorCode::ModelNoMaterial);
}

/// The reference load is the Step's external force at load factor 1, and it reports the Set it
/// cannot find rather than assembling a silently empty one.
#[test]
fn the_reference_load_is_the_external_force_at_load_factor_one() {
    let mesh = cantilever_mesh([2, 1, 1], ElementKind::Hex8);
    let sets = sets_of(&mesh);
    let bodies = vec!["bar".to_string()];
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    p.loads = vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -PRESSURE] }];
    let (f, applied) = nonlinear::reference_load(&p).expect("the Set is there");
    assert!((applied.force[2] + PRESSURE * 0.1 * 0.1).abs() <= 1e-9 * PRESSURE);
    assert!((nonlinear::norm_inf(&f) - f.iter().fold(0.0f64, |m, x| m.max(x.abs()))).abs() == 0.0);
    p.loads = vec![Load::Traction { faces: "nowhere".into(), t: [1.0, 0.0, 0.0] }];
    assert_eq!(nonlinear::reference_load(&p).expect_err("no such Set").code, ErrorCode::SetEmpty);
}

/// N5: at a thousandth of the load, `static-nonlinear` and `static` are the same analysis, and
/// a temperature field reaches the finite-strain element the same way it reaches the linear one.
#[test]
fn a_small_strain_nonlinear_step_reproduces_the_linear_one() {
    let mesh = cantilever_mesh([4, 1, 1], ElementKind::Hex20);
    let sets = sets_of(&mesh);
    let bodies = vec!["bar".to_string()];
    for temperature in [None, Some((vec![20.1; mesh.n_nodes()], 20.0))] {
        let mut p = problem(
            &mesh,
            &sets,
            &bodies,
            Idealisation::Solid3d,
            Formulation::Full,
            vec![fix("root", "xmin", [true, true, true], 0.0)],
        );
        p.loads = vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -1e2] }];
        p.temperature = temperature.clone();
        let linear = run_static(&p, &mut nop).expect("the linear cantilever solves");
        let nl = run_nonlinear(&p, nl_options(2), &mut nop).expect("and so does the nonlinear one");
        let (a, b) = (&linear.fields[&Field::Displacement], &nl.fields[&Field::Displacement]);
        let scale = a.data.iter().fold(0.0f64, |m, x| m.max(x.abs()));
        assert!(scale > 0.0);
        for (i, (x, y)) in a.data.iter().zip(&b.data).enumerate() {
            assert!((x - y).abs() <= 1e-6 * scale, "dof {i}: linear {x}, nonlinear {y}");
        }
        let (a, b) = (&linear.fields[&Field::VonMises], &nl.fields[&Field::VonMises]);
        let scale = a.data.iter().fold(0.0f64, |m, x| m.max(x.abs()));
        for (i, (x, y)) in a.data.iter().zip(&b.data).enumerate() {
            assert!((x - y).abs() <= 1e-4 * scale, "node {i}: linear {x}, nonlinear {y}");
        }
        // the load–deflection history is one row per converged increment, plus the origin
        let history = nl.history.as_ref().expect("a nonlinear Step keeps its load–deflection curve");
        assert_eq!(history.field, Field::Displacement);
        assert_eq!(history.times, vec![0.0, 0.5, 1.0]);
        assert_eq!(history.values.len(), 3);
        assert!(history.values[0].iter().all(|x| *x == 0.0));
        reaction_balance(&nl, [0.0, 0.0, -1e2 * 0.01], 1e2 * 0.01);
    }
}

/// The exact Euler elastica of a cantilever under a fixed-direction transverse tip force, by
/// quadrature of its own first integral rather than from a table.
///
/// With `EI θ'' = −P cos θ`, `θ(0) = 0` and `θ'(L) = 0`, the first integral is
/// `θ' = √(2P/EI) √(sin θ_L − sin θ)`, so for a chosen tip slope `θ_L` the load parameter
/// `α = P L²/EI` and the tip position are three integrals of one integrand. The substitution
/// `θ = θ_L − w²` removes its inverse-square-root endpoint and leaves an analytic function of
/// `w`, which a midpoint rule resolves far past any tolerance this is gated at. Returns
/// `(α, x_tip/L, y_tip/L)`; at small `α` it reduces to `θ_L = α/2` and `y/L = α/3`, which is
/// Euler–Bernoulli.
fn elastica(theta_l: f64) -> (f64, f64, f64) {
    let n = 20_000;
    let h = theta_l.sqrt() / n as f64;
    let (mut i0, mut i1, mut i2) = (0.0, 0.0, 0.0);
    for j in 0..n {
        let w = (j as f64 + 0.5) * h;
        let theta = theta_l - w * w;
        let g = 2.0 * w / (libm::sin(theta_l) - libm::sin(theta)).sqrt();
        i0 += g;
        i1 += g * libm::cos(theta);
        i2 += g * libm::sin(theta);
    }
    (0.5 * (i0 * h) * (i0 * h), i1 / i0, i2 / i0)
}

/// The node of a mesh nearest a point, for probing a Result without the Query machinery.
fn nearest_node(mesh: &Mesh, x: [f64; 3]) -> usize {
    (0..mesh.n_nodes())
        .min_by(|&a, &b| {
            let d = |n: usize| {
                let p = mesh.node(n as u32);
                (0..3).map(|i| (p[i] - x[i]) * (p[i] - x[i])).sum::<f64>()
            };
            d(a).total_cmp(&d(b))
        })
        .expect("a mesh has nodes")
}

/// A slender steel beam of square section, `n` quadratic elements along it.
fn slender_beam(length: f64, side: f64, n: usize) -> Mesh {
    Structured { kind: ElementKind::Hex20, n: [n, 1, 1] }.box_([length, side, side])
}

/// N1: the large-deflection cantilever against the exact elastica. Geometric stiffening is the
/// whole effect — at this load the linear answer is more than half again too large.
#[test]
fn the_large_deflection_cantilever_follows_the_elastica() {
    let (length, side, n) = (1.0, 0.005, 20);
    let (e, i, area) = (YOUNG, side * side * side * side / 12.0, side * side);
    for theta_l in [0.3, 0.6] {
        let (alpha, x_tip, y_tip) = elastica(theta_l);
        let load = alpha * e * i / (length * length);
        let mesh = slender_beam(length, side, n);
        let sets = sets_of(&mesh);
        let bodies = vec!["beam".to_string()];
        let mut p = problem(
            &mesh,
            &sets,
            &bodies,
            Idealisation::Solid3d,
            Formulation::Full,
            vec![fix("root", "xmin", [true, true, true], 0.0)],
        );
        p.loads = vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -load / area] }];
        let res = run_nonlinear(&p, nl_options(5), &mut nop).expect("the elastica converges");
        let tip = nearest_node(&mesh, [length, 0.5 * side, 0.5 * side]);
        let u = &res.fields[&Field::Displacement];
        let (got_x, got_z) = (u.data[tip * 3] / length, u.data[tip * 3 + 2] / length);
        let (want_x, want_z) = (x_tip - 1.0, -y_tip);
        eprintln!("ELASTICA theta={theta_l} alpha={alpha} load={load} x_tip={x_tip} y_tip={y_tip} got_x={got_x} got_z={got_z} ratio_z={} ratio_x={}", got_z/want_z, got_x/want_x);
        assert!(
            (got_z - want_z).abs() <= 0.015 * want_z.abs(),
            "θ_L = {theta_l}, α = {alpha}: tip deflection {got_z} L vs elastica {want_z} L"
        );
        assert!(
            (got_x - want_x).abs() <= 0.04 * want_x.abs(),
            "θ_L = {theta_l}, α = {alpha}: tip shortening {got_x} L vs elastica {want_x} L"
        );
        // and the effect is real: linear theory would say αL/3, which is much further
        let linear = -alpha / 3.0;
        assert!(want_z / linear < 1.0, "α = {alpha}: the elastica must be stiffer than αL/3");
        reaction_balance(&res, [0.0, 0.0, -load], load);
    }
}

/// N2: a cantilever under a transverse tip load *and* an axial compression deflects further
/// than linear theory says, by exactly the beam-column factor `3(tan u / u − 1)/u²` with
/// `u = L√(P/EI)`, which runs away at `u = π/2` — the Euler load of a cantilever.
///
/// The gate is the ratio to the same model's own deflection at `P = 0`, so the element's
/// discretisation error cancels and what is left is the geometric stiffness alone. The exact
/// beam-column solution `δ = (Q/P)(tan(u)/(u/L) − L)` comes from `EI w'' = Q(L−x) + P(δ−w)`
/// with `w(0) = w'(0) = 0`; expanding `tan` recovers `QL³/3EI` as `P → 0`.
#[test]
fn axial_compression_amplifies_a_cantilever_by_the_beam_column_factor() {
    let (length, side, n) = (1.0, 0.005, 40);
    let (i, area) = (side * side * side * side / 12.0, side * side);
    let stiffness = YOUNG * i;
    // A tip load that deflects the beam by 2e-4 L on its own, so that even amplified fivefold
    // the deflection stays small and the closed form's own second-order terms do not enter.
    let tip = 2e-4 * length * 3.0 * stiffness / (length * length * length);
    let mesh = slender_beam(length, side, n);
    let sets = sets_of(&mesh);
    let bodies = vec!["beam".to_string()];
    let probe = nearest_node(&mesh, [length, 0.5 * side, 0.5 * side]);
    let deflection = |axial: f64| -> f64 {
        let mut p = problem(
            &mesh,
            &sets,
            &bodies,
            Idealisation::Solid3d,
            Formulation::Full,
            vec![fix("root", "xmin", [true, true, true], 0.0)],
        );
        p.loads = vec![Load::Traction { faces: "xmax".into(), t: [-axial / area, 0.0, -tip / area] }];
        let res = run_nonlinear(&p, nl_options(4), &mut nop).expect("well below the critical load");
        res.fields[&Field::Displacement].data[probe * 3 + 2]
    };
    let free = deflection(0.0);
    assert!((free / length + 2e-4).abs() <= 0.02 * 2e-4, "the unloaded tip deflection is QL³/3EI: {free}");
    for u in [0.5, 1.0, 1.4] {
        let axial = u * u * stiffness / (length * length);
        let want = 3.0 * (libm::tan(u) / u - 1.0) / (u * u);
        let got = deflection(axial) / free;
        assert!(
            (got - want).abs() <= 0.02 * want,
            "u = {u} (P/P_cr = {}): amplification {got} vs the beam-column factor {want}",
            u * u / (0.25 * PI * PI)
        );
    }
}

/// One way to make a nonlinear Step's controls unusable.
type BreakOption = fn(&mut NlOptions);

/// The controls a nonlinear Step cannot run with, each naming its own field.
#[test]
fn a_nonlinear_step_refuses_controls_it_cannot_run_with() {
    let mesh = cantilever_mesh([1, 1, 1], ElementKind::Hex8);
    let sets = sets_of(&mesh);
    let bodies = vec!["bar".to_string()];
    let p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("root", "xmin", [true, true, true], 0.0)],
    );
    let cases: [(BreakOption, &str); 6] = [
        (|o| o.increments = 0, "increments"),
        (|o| o.converge.max_newton = 0, "nonlinearMaxIterations"),
        (|o| o.converge.tolerance = 0.0, "nonlinearTolerance"),
        (|o| o.converge.tolerance = f64::NAN, "nonlinearTolerance"),
        (|o| o.t_end = 0.0, "tEnd"),
        (|o| o.max_cutbacks = 21, "maxCutbacks"),
    ];
    for (break_it, field) in cases {
        let mut o = nl_options(2);
        break_it(&mut o);
        let e = run_nonlinear(&p, o, &mut nop).expect_err("a Step that cannot run");
        assert_eq!(e.code, ErrorCode::Schema, "{field}");
        assert_eq!(e.where_.as_deref(), Some(field));
        assert!(e.suggestion.is_some(), "{field}");
    }
}

/// The two idealisations whose finite-strain kernel is not written yet say so, and name
/// themselves, rather than integrating a wrong `F₃₃`.
#[test]
fn a_nonlinear_step_refuses_the_idealisations_it_has_no_kernel_for() {
    let mesh = cantilever_mesh([1, 1, 1], ElementKind::Quad4);
    let sets = sets_of(&mesh);
    let bodies = vec!["sheet".to_string()];
    for (id, what) in [
        (Idealisation::PlaneStress { thickness: THICKNESS }, "plane stress"),
        (Idealisation::Axisymmetric, "axisymmetric"),
    ] {
        let p =
            problem(&mesh, &sets, &bodies, id, Formulation::Full, vec![fix("root", "xmin", [true, true, false], 0.0)]);
        let e = run_nonlinear(&p, nl_options(1), &mut nop).expect_err("no kernel for it");
        assert_eq!(e.code, ErrorCode::Unsupported);
        assert!(e.cause.contains(what), "{}", e.cause);
        assert_eq!(e.where_.as_deref(), Some("idealisation"));
    }
}

/// A law that answers every strain with an infinite stress: the smallest way to make a residual
/// non-finite without folding an element, which is the other reason to cut an increment back.
struct Boom;

impl MaterialLaw for Boom {
    fn id(&self) -> &str {
        "boom"
    }
    fn n_props(&self) -> usize {
        2
    }
    fn n_state(&self) -> usize {
        0
    }
    fn prop_names(&self) -> &[&str] {
        &["E", "nu"]
    }
    fn evaluate(&self, b: MaterialBatch<'_>, out: MaterialOut<'_>) -> Result<(), Error> {
        check_batch(self, &b, &out)?;
        let d = isotropic_d(b.props[0], b.props[1]);
        for p in 0..b.n {
            for (i, row) in d.iter().enumerate() {
                out.stress[p * VOIGT + i] = f64::INFINITY;
                out.tangent[p * VOIGT * VOIGT + i * VOIGT..p * VOIGT * VOIGT + (i + 1) * VOIGT].copy_from_slice(row);
            }
        }
        Ok(())
    }
}

static BOOM: Boom = Boom;

/// Every way an increment can fail ends in one `newton.diverged` that names the increment, the
/// load factor and the residual — and every one of them is retried at half the increment first.
#[test]
fn an_increment_that_will_not_converge_is_cut_back_and_then_named() {
    let mesh = cantilever_mesh([2, 1, 1], ElementKind::Hex8);
    let sets = sets_of(&mesh);
    let bodies = vec!["bar".to_string()];
    let base = |constraints: Vec<Constraint>| {
        problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, constraints)
    };
    let root = || fix("root", "xmin", [true, true, true], 0.0);

    // 1. the iterations run out: one iteration is never enough for a finite deformation
    let mut p = base(vec![root(), fix("pull", "xmax", [true, false, false], 0.2)]);
    let mut o = nl_options(1);
    o.converge.max_newton = 1;
    o.max_cutbacks = 0;
    let e = run_nonlinear(&p, o, &mut nop).expect_err("one iteration is not enough");
    assert_eq!(e.code, ErrorCode::NewtonDiverged);
    assert!(e.cause.contains("increment 1") && e.cause.contains("load factor"), "{}", e.cause);
    assert!(e.suggestion.is_some() && e.where_.as_deref() == Some("step"));

    // 2. and with the cutbacks it is allowed, the same deformation arrives in smaller pieces
    //    and the Step finishes: each halving buys back about one Newton iteration
    let stretch = [[1.2, 0.0, 0.0], [0.0, 0.95, 0.0], [0.0, 0.0, 1.0]];
    let patch = patch_mesh(ElementKind::Hex8);
    let mut patch_sets = sets_of(&patch);
    let exact = homogeneous_field(&patch, stretch);
    let held = prescribe_field(&patch, &mut patch_sets, &exact);
    let squeezed = problem(&patch, &patch_sets, &bodies, Idealisation::Solid3d, Formulation::Full, held);
    let mut o = nl_options(1);
    o.converge.max_newton = 4;
    o.max_cutbacks = 3;
    let res = run_nonlinear(&squeezed, o, &mut nop).expect("halving the increment gets there");
    assert!(res.scalars["cutbacks"] >= 1.0, "{:?}", res.scalars);
    assert!(res.scalars["increments_taken"] > 1.0);
    assert_eq!(res.scalars["load_factor"], 1.0);

    // 3. a folded deformed element: squashing the bar past zero length inverts it
    let squashed = base(vec![root(), fix("pull", "xmax", [true, false, false], -1.5)]);
    let mut o = nl_options(1);
    o.max_cutbacks = 0;
    let e = run_nonlinear(&squashed, o, &mut nop).expect_err("a folded element");
    assert_eq!(e.code, ErrorCode::NewtonDiverged);

    // 4. a non-finite residual, from a law that answers with one
    p.materials = vec![Material { law: &BOOM, ..steel() }];
    let mut o = nl_options(1);
    o.max_cutbacks = 0;
    let e = run_nonlinear(&p, o, &mut nop).expect_err("an infinite residual");
    assert_eq!(e.code, ErrorCode::NewtonDiverged);
    assert!(e.cause.contains("NaN"), "{}", e.cause);

    // 5. a material the checks cannot see is a failure, not something to cut back from
    p.materials = vec![Material { props: vec![YOUNG], ..steel() }];
    assert!(checks::all(&p).is_empty(), "the well-posedness checks never look at the props");
    let e = run_nonlinear(&p, nl_options(1), &mut nop).expect_err("a law with one prop instead of two");
    assert_eq!(e.code, ErrorCode::MaterialProps);
}

/// A host that says stop is obeyed at every phase a nonlinear Step reports from.
#[test]
fn a_host_that_says_stop_cancels_a_nonlinear_step() {
    let mesh = cantilever_mesh([2, 1, 1], ElementKind::Hex8);
    let sets = sets_of(&mesh);
    let bodies = vec!["bar".to_string()];
    let mut p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("root", "xmin", [true, true, true], 0.0)],
    );
    p.loads = vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -1e5] }];
    let mut seen = 0;
    {
        let mut count = |_p: Progress| {
            seen += 1;
            true
        };
        run_nonlinear(&p, nl_options(2), &mut count).expect("it runs");
    }
    assert!(seen > 3, "a nonlinear Step reports per iteration, not per Step");
    for at in 0..seen {
        let mut stop = cancel_on(at);
        let e = run_nonlinear(&p, nl_options(2), &mut stop).expect_err("cancelled");
        assert_eq!(e.code, ErrorCode::Cancelled, "at report {at}");
    }
}

/// A bonded tie is eliminated *inside* the Newton loop, not around it: a beam cut in two and
/// welded back together reaches the same large deflection as the single-Body beam, its
/// reactions still balance the applied load, and the tie force never leaks into them.
#[test]
fn a_welded_beam_reaches_the_same_large_deflection_as_the_whole_one() {
    let traction = 2.0e7;
    let root = |on: &str| vec![fix("root", on, [true, true, true], 0.0)];
    let whole = Structured { kind: ElementKind::Hex20, n: [8, 1, 1] }.box_([1.0, 0.05, 0.05]);
    let whole_sets = sets_of(&whole);
    let one = one_body();
    let mut wp = problem(&whole, &whole_sets, &one, Idealisation::Solid3d, Formulation::Full, root("xmin"));
    wp.loads = vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -traction] }];
    let whole_res = run_nonlinear(&wp, nl_options(4), &mut nop).expect("the whole beam bends");

    let half = Structured { kind: ElementKind::Hex20, n: [4, 1, 1] }.box_([0.5, 0.05, 0.05]);
    let mesh = join(&half, &half, [0.5, 0.0, 0.0]);
    let sets = sets_of(&mesh);
    let bodies = two_bodies();
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, root("a.xmin"));
    p.couplings = vec![bond(1e-9)];
    p.loads = vec![Load::Traction { faces: "b.xmax".into(), t: [0.0, 0.0, -traction] }];
    let welded = run_nonlinear(&p, nl_options(4), &mut nop).expect("and so does the welded one");

    let tip = |mesh: &Mesh, res: &StepResult| {
        let node = nearest_node(mesh, [1.0, 0.025, 0.025]);
        res.fields[&Field::Displacement].data[node * 3 + 2]
    };
    let (a, b) = (tip(&whole, &whole_res), tip(&mesh, &welded));
    assert!(a < -0.05, "the load has to be large enough to be nonlinear at all: {a}");
    assert!((a - b).abs() <= 1e-6 * a.abs(), "whole {a} vs welded {b}");
    // A tie carries no external load, so the supports still carry the whole of it.
    reaction_balance(&welded, [0.0, 0.0, -traction * 0.05 * 0.05], traction * 0.05 * 0.05);
    assert!(welded.warnings.is_empty(), "{:?}", welded.warnings);
    assert_eq!(welded.scalars["load_factor"], 1.0);
}

/// A nonlinear Result is bit-identical at one and many threads: the assembly scatter, the
/// residual norms and therefore every convergence decision are all fixed-order.
#[test]
fn a_nonlinear_step_is_bit_identical_at_one_and_many_threads() {
    let mesh = cantilever_mesh([4, 2, 2], ElementKind::Hex20);
    let sets = sets_of(&mesh);
    let bodies = vec!["bar".to_string()];
    let mut p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("root", "xmin", [true, true, true], 0.0)],
    );
    p.loads = vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -2e7] }];
    let run = |threads: usize| {
        let step = Step::StaticNonlinear(nl_options(3));
        pollster::block_on(procedure::run(&p, &step, &Pool::new(threads), None, None, &mut nop)).expect("it converges")
    };
    let (one, many) = (run(1), run(4));
    for field in [Field::Displacement, Field::Stress, Field::Reaction] {
        for (a, b) in one.fields[&field].data.iter().zip(&many.fields[&field].data) {
            assert_eq!(a.to_bits(), b.to_bits(), "{field:?}");
        }
    }
    assert_eq!(one.scalars, many.scalars);
}

/// The load factor is the Step's Amplitude when it has one, so a load–unload cycle is one Step
/// and the Result reports where the cycle ended rather than where it peaked.
#[test]
fn an_amplitude_drives_the_load_factor_of_a_nonlinear_step() {
    let mesh = cantilever_mesh([2, 1, 1], ElementKind::Hex20);
    let sets = sets_of(&mesh);
    let bodies = vec!["bar".to_string()];
    let mut p = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("root", "xmin", [true, true, true], 0.0)],
    );
    p.loads = vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -1e6] }];
    let mut o = nl_options(4);
    o.amplitude = Some(procedure::Amplitude::Table { t: vec![0.0, 0.5, 1.0], value: vec![0.0, 1.0, 0.0] });
    let res = run_nonlinear(&p, o, &mut nop).expect("a load–unload cycle converges");
    assert_eq!(res.scalars["load_factor"], 0.0);
    let history = res.history.as_ref().expect("the cycle is the history");
    assert_eq!(history.times, vec![0.0, 0.5, 1.0, 0.5, 0.0]);
    // an elastic material comes back to where it started
    let u = &res.fields[&Field::Displacement];
    assert!(u.data.iter().all(|x| x.abs() < 1e-12), "an elastic cycle returns to the origin");
    assert!(history.values[2].iter().any(|x| x.abs() > 1e-6), "and it went somewhere in between");
}

// -------------------------------------- implicit dynamics (Benchmarks F2c, F3, F3b, F3c)

/// The P-wave modulus `E(1−ν)/((1+ν)(1−2ν))`: what a hex8 held flat at both ends stretches with.
fn p_wave_modulus() -> f64 {
    YOUNG * (1.0 - POISSON) / ((1.0 + POISSON) * (1.0 - 2.0 * POISSON))
}

/// Benchmark F3's single degree of freedom: one hex8 cube, `xmin` clamped, `xmax` held flat in
/// y and z under a uniform axial traction. The four free DOFs are the axial displacements of the
/// loaded face, which symmetry moves as one, so the finite-element system *is* the scalar
/// `m* ẍ + k* x = P` with the closed-form `k* = M A / L` (uniaxial strain, `M` the P-wave
/// modulus) and `m* = ρ A L / 3` (the consistent mass of a linear ramp).
fn axial_sdof<'a>(
    mesh: &'a Mesh,
    sets: &'a BTreeMap<String, ResolvedSet>,
    bodies: &'a [String],
    traction: f64,
) -> Problem<'a> {
    let held = vec![fix("root", "xmin", [true, true, true], 0.0), fix("guide", "xmax", [false, true, true], 0.0)];
    let mut p = problem(mesh, sets, bodies, Idealisation::Solid3d, Formulation::Full, held);
    p.loads = vec![Load::Traction { faces: "xmax".into(), t: [traction, 0.0, 0.0] }];
    p
}

fn implicit_step(
    dt: f64,
    t_end: f64,
    alpha: f64,
    rayleigh: (f64, f64),
    initial_velocity: Option<Vec<f64>>,
    output_every: usize,
) -> Step {
    Step::Implicit {
        dt,
        t_end,
        alpha,
        rayleigh_alpha: rayleigh.0,
        rayleigh_beta: rayleigh.1,
        initial_velocity,
        output_every,
        amplitude: None,
    }
}

/// The scalar HHT-α method written straight from its equation of motion under a constant load,
/// solving for the acceleration:
/// `[m + (1+α)γΔt c + (1+α)βΔt² k] a₁ = f − (1+α)(c ṽ + k ũ) + α(c v₀ + k u₀)`.
/// It shares no algebra with the engine's effective-stiffness form.
#[allow(clippy::too_many_arguments)]
fn scalar_hht(m: f64, k: f64, c: f64, f: f64, alpha: f64, dt: f64, steps: usize, v0: f64) -> Vec<(f64, f64)> {
    let (beta, gamma) = ((1.0 - alpha).powi(2) / 4.0, 0.5 - alpha);
    let (mut u, mut v) = (0.0, v0);
    let mut a = (f - c * v) / m;
    let mut out = vec![(u, v)];
    for _ in 0..steps {
        let ut = u + dt * v + dt * dt * (0.5 - beta) * a;
        let vt = v + dt * (1.0 - gamma) * a;
        let lhs = m + (1.0 + alpha) * gamma * dt * c + (1.0 + alpha) * beta * dt * dt * k;
        a = (f - (1.0 + alpha) * (c * vt + k * ut) + alpha * (c * v + k * u)) / lhs;
        u = ut + beta * dt * dt * a;
        v = vt + gamma * dt * a;
        out.push((u, v));
    }
    out
}

// ------------------------------------------------------------- invariant suite (#397)
//
// Every property here holds for a correct linear finite-element solver whatever the answer,
// so each one catches a whole class of bug that no answer benchmark can: an asymmetry, a
// hard-coded axis, a dimensional slip, a conversion applied twice. Where a property is exact
// the gate is round-off; where it is exact only up to a discretisation effect the bound is
// derived in the test and said so. The catalogue rows are K1–K9 in `docs/BENCHMARKS.md`.

use femlab_engine::fem::quadrature::{TET_125, TRI_25};
use femlab_engine::{Command, Engine, NoClock};
use femlab_geometry::{free, lattice};

/// `max |a − b| / max |b|`: the relative disagreement of two fields, which every round-off
/// gate below is measured in. Against an all-zero reference it is the absolute disagreement,
/// so a field that must vanish (an explicit Step's applied totals) is still gated.
fn rel_diff(a: &[f64], b: &[f64]) -> f64 {
    assert_eq!(a.len(), b.len());
    let scale = b.iter().fold(0.0f64, |m, v| m.max(v.abs()));
    let d = a.iter().zip(b).fold(0.0f64, |m, (x, y)| m.max((x - y).abs()));
    if scale > 0.0 {
        d / scale
    } else {
        d
    }
}

/// `rel_diff` gated at `tol`, naming the case; returns the measured value so a test can report
/// the tightest tolerance it actually holds at.
fn gate(label: &str, got: &[f64], want: &[f64], tol: f64) -> f64 {
    let d = rel_diff(got, want);
    assert!(d <= tol, "{label}: relative disagreement {d:e} exceeds {tol:e}");
    d
}

const IDENTITY: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

fn mat3(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut c = [[0.0; 3]; 3];
    for (i, row) in c.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    c
}

fn transpose(a: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    [[a[0][0], a[1][0], a[2][0]], [a[0][1], a[1][1], a[2][1]], [a[0][2], a[1][2], a[2][2]]]
}

/// `Rz(c) · Ry(b) · Rx(a)`: with all three angles nonzero no entry is zero, so no axis of the
/// original frame survives into the rotated one.
fn rotation(a: f64, b: f64, c: f64) -> [[f64; 3]; 3] {
    let (sa, ca) = (libm::sin(a), libm::cos(a));
    let (sb, cb) = (libm::sin(b), libm::cos(b));
    let (sc, cc) = (libm::sin(c), libm::cos(c));
    let rx = [[1.0, 0.0, 0.0], [0.0, ca, -sa], [0.0, sa, ca]];
    let ry = [[cb, 0.0, sb], [0.0, 1.0, 0.0], [-sb, 0.0, cb]];
    let rz = [[cc, -sc, 0.0], [sc, cc, 0.0], [0.0, 0.0, 1.0]];
    mat3(&rz, &mat3(&ry, &rx))
}

fn rot_vec(r: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|i| r[i][0] * v[0] + r[i][1] * v[1] + r[i][2] * v[2])
}

/// Every node of `m` rotated by `r`; connectivity and Sets untouched.
fn rotate_mesh(m: &Mesh, r: &[[f64; 3]; 3]) -> Mesh {
    let mut out = m.clone();
    for n in 0..m.n_nodes() {
        out.coords[3 * n..3 * n + 3].copy_from_slice(&rot_vec(r, m.node(n as u32)));
    }
    out
}

/// Newmark's displacement difference equation (Hughes, *The Finite Element Method*, §9.1) for
/// `m ü + c u̇ + k u = f` at `β = ¼`, `γ = ½`, from rest, started by one acceleration-form step:
/// `A u₁ + B u₀ + C u₋₁ = β f₁ + (½+γ−2β) f₀ + (½−γ+β) f₋₁` with
/// `A = m/Δt² + γc/Δt + βk`, `B = −2m/Δt² + (1−2γ)c/Δt + (½+γ−2β)k`,
/// `C = m/Δt² − (1−γ)c/Δt + (½−γ+β)k`. A constant load's three weights sum to one, and
/// `A + B + C = k`, so in the increments `d = u₁ − u₀` the same equation reads
/// `A d₁ = f − k u₀ + C d₀` — the form evaluated here, because it does not cancel two
/// `m/Δt²`-sized terms against each other at every step.
fn three_term_newmark(m: f64, k: f64, c: f64, f: f64, dt: f64, steps: usize) -> Vec<f64> {
    let (beta, gamma) = (0.25, 0.5);
    let a = m / (dt * dt) + gamma * c / dt + beta * k;
    let cc = m / (dt * dt) - (1.0 - gamma) * c / dt + (0.5 - gamma + beta) * k;
    let mut u = vec![0.0, scalar_hht(m, k, c, f, 0.0, dt, 1, 0.0)[1].0];
    let mut d = u[1];
    for n in 1..steps {
        d = (f - k * u[n] + cc * d) / a;
        u.push(u[n] + d);
    }
    u
}

/// Benchmark F3: the closed-form damped step response at 1 %, and the hand-written scalar
/// recurrences at 1e-12 — the second is what tells a correct integrator from a nearly
/// correct one, and the reactions carry the inertia the supports really feel.
#[test]
fn a_single_degree_of_freedom_under_a_step_load_matches_the_closed_form_and_the_scalar_recurrences() {
    let (side, traction) = (0.1, 1e7);
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([side; 3]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let p = axial_sdof(&mesh, &sets, &bodies, traction);
    let area = side * side;
    let (k, m, f) = (p_wave_modulus() * area / side, DENSITY * area * side / 3.0, traction * area);
    let omega = (k / m).sqrt();
    let period = 2.0 * PI / omega;
    let u_static = f / k;
    let tip: Vec<usize> = (0..mesh.n_nodes()).filter(|&n| mesh.node(n as u32)[0] > 0.5 * side).collect();
    assert_eq!(tip.len(), 4);
    // The common axial displacement of the loaded face, with every other DOF exactly still. The
    // four DOFs agree to round-off: the antisymmetric modes of the face are excited only by the
    // factorisation's own rounding, which the scalar oracle cannot see.
    let face = |frame: &[f64]| -> f64 {
        let x = tip.iter().map(|&node| frame[node * 3]).sum::<f64>() / 4.0;
        for (dof, &value) in frame.iter().enumerate() {
            if tip.contains(&(dof / 3)) && dof % 3 == 0 {
                assert!((value - x).abs() <= 1e-11 * u_static, "dof {dof}: {value} vs {x}");
            } else {
                assert_eq!(value, 0.0, "dof {dof} is held");
            }
        }
        x
    };
    for zeta in [0.0, 0.05] {
        // Half the damping ratio from each Rayleigh term: ζ = αR/(2ω) + βR·ω/2.
        let rayleigh = (zeta * omega, zeta / omega);
        let c = rayleigh.0 * m + rayleigh.1 * k;
        let res = run_step(&p, &implicit_step(period / 200.0, 5.0 * period, 0.0, rayleigh, None, 1)).expect("solves");
        let (dt, steps) = (res.scalars["dt"], res.scalars["steps"] as usize);
        assert!(dt <= period / 200.0 && steps >= 1000);
        let h = res.history.as_ref().expect("a history");
        assert_eq!((h.field, h.times.len()), (Field::Displacement, steps + 1));
        assert_eq!(*h.times.last().unwrap(), 5.0 * period);
        let omega_d = omega * (1.0 - zeta * zeta).sqrt();
        let exact = |t: f64| {
            u_static
                * (1.0
                    - libm::exp(-zeta * omega * t)
                        * (libm::cos(omega_d * t) + zeta * omega / omega_d * libm::sin(omega_d * t)))
        };
        let recurrence = three_term_newmark(m, k, c, f, dt, steps);
        let mut worst = 0.0f64;
        for (n, (&t, frame)) in h.times.iter().zip(&h.values).enumerate() {
            let x = face(frame);
            worst = worst.max((x - exact(t)).abs());
            assert!((x - recurrence[n]).abs() <= 1e-12 * u_static, "ζ = {zeta}, step {n}: {x} vs {}", recurrence[n]);
        }
        assert!(worst <= 0.01 * u_static, "ζ = {zeta}: worst {worst} against u_static {u_static}");
        assert!(worst > 1e-6 * u_static, "the discretisation error is measurable, not a coincidence");
        // Reactions include the inertia and the damping: on the root the mass coupling of the
        // ramp is `ρAL/6 = m*/2`, the stiffness coupling `−k*`, so
        // `R = −k x + (m/2) a + (αR m/2 − βR k) v`, and the d'Alembert applied total closes it.
        let (u_end, v_end) = scalar_hht(m, k, c, f, 0.0, dt, steps, 0.0)[steps];
        let a_end = (f - c * v_end - k * u_end) / m;
        let want = -k * u_end + 0.5 * m * a_end + (0.5 * rayleigh.0 * m - rayleigh.1 * k) * v_end;
        let root = reaction_of(&res, "root");
        assert!((root[0] - want).abs() <= 1e-9 * f, "ζ = {zeta}: root reaction {} vs {want}", root[0]);
        assert!(reaction_of(&res, "guide").iter().all(|r| r.abs() <= 1e-9 * f), "the guide carries nothing");
        let closing = res.scalars["applied_total_x"] + root[0];
        assert!(closing.abs() <= 1e-9 * f, "ζ = {zeta}: balance {closing}");
        assert!((res.scalars["load_total_x"] - f).abs() <= 1e-9 * f);
        assert!(res.fields.contains_key(&Field::VonMises) && res.fields.contains_key(&Field::Reaction));
        assert_eq!(res.solver.solver, "cpu-direct");
        assert_eq!(res.solver.iterations, steps);
    }
    // HHT-α = −0.05 at ζ = 0.05, against the acceleration-form scalar method: this pins the
    // `α v₀` and `α K u₀` carry-over terms that a plain Newmark step does not have.
    let rayleigh = (0.05 * omega, 0.05 / omega);
    let c = rayleigh.0 * m + rayleigh.1 * k;
    let res = run_step(&p, &implicit_step(period / 20.0, 3.0 * period, -0.05, rayleigh, None, 1)).expect("solves");
    let (dt, steps) = (res.scalars["dt"], res.scalars["steps"] as usize);
    let oracle = scalar_hht(m, k, c, f, -0.05, dt, steps, 0.0);
    for (n, frame) in res.history.as_ref().unwrap().values.iter().enumerate() {
        let x = face(frame);
        assert!((x - oracle[n].0).abs() <= 1e-12 * u_static, "step {n}: {x} vs {}", oracle[n].0);
    }
    assert_eq!((res.scalars["alpha"], res.scalars["beta"], res.scalars["gamma"]), (-0.05, 1.05f64 * 1.05 / 4.0, 0.55));
}

/// Benchmark F3, energy: `½vᵀMv + ½uᵀKu` is conserved by average acceleration to round-off,
/// `E − fᵀu` under a step load likewise, and HHT at α = −0.05 dissipates it. The velocity at
/// each retained frame is the one Newmark's own relations imply for the retained displacements.
#[test]
fn average_acceleration_conserves_the_discrete_energy_and_hht_dissipates_it() {
    let side = 0.1;
    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([side; 3]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let area = side * side;
    let (k, m) = (p_wave_modulus() * area / side, DENSITY * area * side / 3.0);
    let period = 2.0 * PI / (k / m).sqrt();
    let tip = (0..mesh.n_nodes()).find(|&n| mesh.node(n as u32)[0] > 0.5 * side).unwrap();
    let v0 = 2.0;
    let kick = Some(vec![v0; mesh.n_nodes() * 3]);
    let e0 = 0.5 * m * v0 * v0;
    // Free vibration from an initial velocity, ten periods at twenty steps per period.
    let free = axial_sdof(&mesh, &sets, &bodies, 0.0);
    for alpha in [0.0, -0.05] {
        let res = run_step(&free, &implicit_step(period / 20.0, 10.0 * period, alpha, (0.0, 0.0), kick.clone(), 1))
            .expect("solves");
        let (dt, steps) = (res.scalars["dt"], res.scalars["steps"] as usize);
        assert!((res.scalars["energy_initial"] - e0).abs() <= 1e-12 * e0, "{}", res.scalars["energy_initial"]);
        let (beta, gamma) = ((1.0 - alpha).powi(2) / 4.0, 0.5 - alpha);
        let u: Vec<f64> = res.history.as_ref().unwrap().values.iter().map(|frame| frame[tip * 3]).collect();
        let (mut v, mut a) = (v0, 0.0);
        let mut energy = vec![e0];
        for n in 0..steps {
            let ut = u[n] + dt * v + dt * dt * (0.5 - beta) * a;
            let vt = v + dt * (1.0 - gamma) * a;
            a = (u[n + 1] - ut) / (beta * dt * dt);
            v = vt + gamma * dt * a;
            energy.push(0.5 * m * v * v + 0.5 * k * u[n + 1] * u[n + 1]);
        }
        let e_end = res.scalars["energy_final"];
        assert!((e_end - energy[steps]).abs() <= 1e-12 * e0, "α = {alpha}: {e_end} vs {}", energy[steps]);
        if alpha == 0.0 {
            for (n, e) in energy.iter().enumerate() {
                assert!((e - e0).abs() <= 1e-12 * e0, "step {n}: {e} vs {e0}");
            }
        } else {
            // Sampled once per period, so the within-period exchange of the α-method's own
            // energy norm does not hide the monotone loss.
            let per_period = steps / 10;
            let samples: Vec<f64> = (0..=10).map(|i| energy[i * per_period]).collect();
            for pair in samples.windows(2) {
                assert!(pair[1] < pair[0], "HHT must lose energy every period: {samples:?}");
            }
            assert!(e_end < 0.99 * e0 && e_end > 0.9 * e0, "α = −0.05 at T/20 loses a few percent: {e_end} of {e0}");
        }
    }
    // A step load: `E − f·u` is the conserved quantity at α = 0.
    let traction = 1e7;
    let loaded = axial_sdof(&mesh, &sets, &bodies, traction);
    let res =
        run_step(&loaded, &implicit_step(period / 20.0, 10.0 * period, 0.0, (0.0, 0.0), None, 1)).expect("solves");
    let f = traction * area;
    let u_end = res.fields[&Field::Displacement].data[tip * 3];
    let drift = res.scalars["energy_final"] - f * u_end - res.scalars["energy_initial"];
    assert!(drift.abs() <= 1e-12 * f * f / k, "{drift} against {}", f * f / k);
}

/// Benchmark F3b: the B4 cantilever under a step tip load rings at its first mode with twice
/// the static deflection, and HHT damps the mesh modes without moving that period.
#[test]
fn a_cantilever_under_a_step_tip_load_rings_at_its_first_mode_with_twice_the_static_deflection() {
    let (length, side) = (1.0, 0.05);
    let mesh = Structured { kind: ElementKind::Hex20, n: [20, 2, 2] }.box_([length, side, side]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let held = vec![fix("root", "xmin", [true, true, true], 0.0)];
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, held);
    let (force, area) = (100.0, side * side);
    p.loads = vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -force / area] }];
    let inertia = side.powi(4) / 12.0;
    // B4's Euler–Bernoulli first mode and B1's Timoshenko static deflection.
    let f1 = 1.8751040687f64.powi(2) / (2.0 * PI) * (YOUNG * inertia / (DENSITY * area * length.powi(4))).sqrt();
    let period = 1.0 / f1;
    let shear = YOUNG / (2.0 * (1.0 + POISSON));
    let delta = force * length.powi(3) / (3.0 * YOUNG * inertia) + force * length / (5.0 / 6.0 * shear * area);
    let tip = (0..mesh.n_nodes())
        .find(|&n| {
            let x = mesh.node(n as u32);
            (x[0] - length).abs() < 1e-9 && (x[1] - 0.5 * side).abs() < 1e-9 && (x[2] - 0.5 * side).abs() < 1e-9
        })
        .expect("a node at the tip centre");
    let mut periods = Vec::new();
    let mut ringing = Vec::new();
    let mut energies = Vec::new();
    for alpha in [0.0, -0.05] {
        let res =
            run_step(&p, &implicit_step(period / 100.0, 2.0 * period, alpha, (0.0, 0.0), None, 1)).expect("solves");
        let h = res.history.as_ref().unwrap();
        let w: Vec<f64> = h.values.iter().map(|u| u[tip * 3 + 2]).collect();
        let peak = w.iter().copied().fold(0.0, f64::min);
        assert!((peak + 2.0 * delta).abs() <= 0.05 * 2.0 * delta, "α = {alpha}: peak {peak} vs {}", -2.0 * delta);
        // The period from two successive upward crossings of the static level.
        let crossings: Vec<f64> = (1..w.len())
            .filter(|&i| w[i - 1] < -delta && w[i] >= -delta)
            .map(|i| h.times[i - 1] + (-delta - w[i - 1]) / (w[i] - w[i - 1]) * (h.times[i] - h.times[i - 1]))
            .collect();
        assert!(crossings.len() >= 2, "α = {alpha}: {crossings:?}");
        let measured = crossings[1] - crossings[0];
        assert!((measured - period).abs() <= 0.03 * period, "α = {alpha}: period {measured} vs {period}");
        periods.push(measured);
        // At the end of two periods the first mode is nearly back at rest, so what energy is
        // left is the mesh modes': average acceleration conserves `E − fᵀu` to round-off and
        // keeps every one of them ringing (the second difference of the tip history is its
        // acceleration), HHT dissipates a good part of it.
        let dt = res.scalars["dt"];
        ringing.push(
            (1..w.len() - 1).map(|i| ((w[i + 1] - 2.0 * w[i] + w[i - 1]) / (dt * dt)).powi(2)).sum::<f64>().sqrt(),
        );
        let mut f = vec![0.0; p.n_dofs()];
        assemble_loads(&p, &mut f).unwrap();
        let work: f64 = f.iter().zip(&res.fields[&Field::Displacement].data).map(|(f, u)| f * u).sum();
        let e_end = res.scalars["energy_final"];
        let total = e_end - work - res.scalars["energy_initial"];
        if alpha == 0.0 {
            let scale = 2.0 * force * delta;
            assert!(total.abs() <= 1e-9 * scale, "average acceleration conserves E − fᵀu: {total} of {scale}");
        } else {
            assert!(total < -0.05 * e_end, "HHT dissipates: {total} of {e_end}");
        }
        energies.push(e_end);
        let closing: f64 = (0..3)
            .map(|c| res.scalars[&format!("applied_total_{}", ["x", "y", "z"][c])] + reaction_of(&res, "root")[c])
            .map(f64::abs)
            .sum();
        assert!(closing <= 1e-8 * force, "α = {alpha}: balance {closing}");
    }
    assert!((periods[1] - periods[0]).abs() <= 0.01 * periods[0], "{periods:?}");
    assert!(energies[1] < 0.85 * energies[0], "HHT must damp the high modes: {energies:?}");
    assert!(ringing[1] < 0.95 * ringing[0], "and their acceleration with them: {ringing:?}");
}

/// Benchmark F3c: a fixed–free bar suddenly loaded at its end, against the independent Fourier
/// series of the wave solution on three refinements, and second-order convergence in Δt.
#[test]
fn a_suddenly_loaded_bar_matches_the_wave_series_and_converges_at_second_order_in_time() {
    let (length, side, traction) = (1.0, 0.05, 1e6);
    let c = (YOUNG / DENSITY).sqrt();
    let period = 4.0 * length / c;
    let t_end = 0.35 * period;
    let static_tip = traction * length / YOUNG;
    let series = |t: f64| {
        let sum: f64 = (1..200_000u64)
            .step_by(2)
            .map(|n| libm::cos(n as f64 * PI * c * t / (2.0 * length)) / (n * n) as f64)
            .sum();
        static_tip * (1.0 - 8.0 / (PI * PI) * sum)
    };
    let bar = |nx: usize| Structured { kind: ElementKind::Hex8, n: [nx, 1, 1] }.box_([length, side, side]);
    let tip_of = |mesh: &Mesh, res: &StepResult| {
        probe(mesh, &res.fields[&Field::Displacement], [length, 0.5 * side, 0.5 * side]).expect("inside").1[0]
    };
    let bodies = one_body();
    let mut errors = Vec::new();
    for (nx, per_period) in [(10, 100.0), (20, 200.0), (40, 400.0)] {
        let mesh = bar(nx);
        let sets = sets_of(&mesh);
        let held = vec![fix("root", "xmin", [true, true, true], 0.0)];
        let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, held);
        // ν = 0: the solid is the one-dimensional bar exactly.
        p.materials[0].props = vec![YOUNG, 0.0];
        p.loads = vec![Load::Traction { faces: "xmax".into(), t: [traction, 0.0, 0.0] }];
        let res = run_step(&p, &implicit_step(period / per_period, t_end, 0.0, (0.0, 0.0), None, 1_000_000)).unwrap();
        let err = (tip_of(&mesh, &res) - series(t_end)).abs() / static_tip;
        assert!(err <= 0.02, "nx = {nx}: {err}");
        errors.push(err);
    }
    assert!(errors[1] < errors[0] && errors[2] < errors[1], "{errors:?}");

    // Δt refinement on the coarsest mesh against a reference 64× finer than the finest step.
    let mesh = bar(10);
    let sets = sets_of(&mesh);
    let held = vec![fix("root", "xmin", [true, true, true], 0.0)];
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, held);
    p.materials[0].props = vec![YOUNG, 0.0];
    p.loads = vec![Load::Traction { faces: "xmax".into(), t: [traction, 0.0, 0.0] }];
    let run = |per_period: f64| {
        let res = run_step(&p, &implicit_step(period / per_period, t_end, 0.0, (0.0, 0.0), None, 1_000_000)).unwrap();
        (res.scalars["dt"], tip_of(&mesh, &res))
    };
    let (_, reference) = run(25_600.0);
    let (mut h, mut e) = (Vec::new(), Vec::new());
    for per_period in [400.0, 800.0, 1600.0] {
        let (dt, tip) = run(per_period);
        h.push(dt);
        e.push((tip - reference).abs());
    }
    let rate = observed_rate(&h, &e);
    assert!(rate > 1.9 && rate < 2.3, "observed rate {rate} from {e:?}");
}

/// Benchmark F2c through the implicit procedure: rigid free fall from an initial velocity is
/// `u = v₀ t + g t²/2` exactly, because the α-method is exact for a constant acceleration.
#[test]
fn implicit_free_fall_from_an_initial_velocity_is_exact() {
    let velocity = [0.3, -0.2, 0.1];
    let gravity = [0.0, 0.0, -9.81];
    let mesh = Structured { kind: ElementKind::Hex8, n: [2, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    p.loads = vec![Load::Gravity { g: gravity }];
    let t_end = 1e-2;
    let kick = Some(velocity.repeat(mesh.n_nodes()));
    let res = run_step(&p, &implicit_step(1e-3, t_end, -0.05, (0.0, 0.0), kick, 3)).expect("a free body integrates");
    let h = res.history.as_ref().unwrap();
    assert_eq!(h.times.len(), 5);
    assert_eq!(*h.times.last().unwrap(), t_end);
    for (&time, values) in h.times.iter().zip(&h.values) {
        for (i, displacement) in values.iter().enumerate() {
            let c = i % 3;
            let want = velocity[c] * time + 0.5 * gravity[c] * time * time;
            assert!((displacement - want).abs() <= 1e-10 * t_end, "u = {displacement} vs {want} at {time}");
        }
    }
    // Nothing holds it, so nothing reacts, and the d'Alembert total is zero.
    assert!(res.reactions.is_empty());
    for axis in ["x", "y", "z"] {
        assert!(res.scalars[&format!("applied_total_{axis}")].abs() <= 1e-9 * res.scalars["load_total_z"].abs());
    }
}

/// A prescribed displacement is applied at `t = 0` and held: the free DOFs oscillate about the
/// static answer while the held ones never move, and a thermal load enters through `f_thermal`.
#[test]
fn a_prescribed_displacement_is_held_still_through_an_implicit_step() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [2, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let pull = 1e-4;
    let held = vec![fix("root", "xmin", [true, true, true], 0.0), fix("pull", "xmax", [true, false, false], pull)];
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, held);
    p.temperature = Some((vec![20.0; mesh.n_nodes()], 0.0));
    let c = (YOUNG / DENSITY).sqrt();
    let res = run_step(&p, &implicit_step(0.05 / c, 4.0 / c, 0.0, (0.0, 0.0), None, 1)).expect("solves");
    let h = res.history.as_ref().unwrap();
    let mid: Vec<usize> = (0..mesh.n_nodes()).filter(|&n| (mesh.node(n as u32)[0] - 0.5).abs() < 1e-9).collect();
    let fixed = resolve(&p).unwrap().fixed;
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for frame in &h.values {
        for &(dof, value) in &fixed {
            assert_eq!(frame[dof as usize], value);
        }
        let x = frame[mid[0] * 3];
        lo = lo.min(x);
        hi = hi.max(x);
    }
    // The middle of the bar overshoots and undershoots the static half-pull (plus the free
    // thermal expansion, which the clamped root turns into a wave of its own).
    assert!(lo < 0.5 * pull && hi > 0.5 * pull, "{lo} .. {hi} around {}", 0.5 * pull);
    let root = reaction_of(&res, "root");
    assert!(root[0].is_finite() && root[0] != 0.0);
}

/// Every refusal an implicit Step can make is a structured error naming its field.
#[test]
fn implicit_dynamics_refuses_what_it_cannot_integrate() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [2, 1, 1] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let root = || vec![fix("root", "xmin", [true, true, true], 0.0)];
    let p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, root());
    let (dt, t_end) = (1e-5, 3e-5);
    let cases: [(Step, ErrorCode, &str); 4] = [
        (implicit_step(dt, t_end, 0.5, (0.0, 0.0), None, 1), ErrorCode::Schema, "alpha"),
        (implicit_step(dt, t_end, 0.0, (-1.0, 0.0), None, 1), ErrorCode::Schema, "rayleighAlpha"),
        (implicit_step(dt, t_end, 0.0, (0.0, f64::NAN), None, 1), ErrorCode::Schema, "rayleighBeta"),
        (implicit_step(0.0, t_end, 0.0, (0.0, 0.0), None, 1), ErrorCode::Schema, "dt"),
    ];
    for (step, code, field) in cases {
        let e = run_step(&p, &step).expect_err(field);
        assert_eq!((e.code, e.where_.as_deref()), (code, Some(field)), "{}", e.cause);
    }
    // A moving prescribed displacement is base motion, which the constant coupling cannot carry.
    let mut moving = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("root", "xmin", [true, true, true], 0.0), fix("pull", "xmax", [true, false, false], 1e-4)],
    );
    let mut ramped = implicit_step(dt, t_end, 0.0, (0.0, 0.0), None, 1);
    let Step::Implicit { amplitude, .. } = &mut ramped else { panic!() };
    *amplitude = Some(procedure::Amplitude::Sine { amplitude: 1.0, period: 1e-3 });
    let e = run_step(&moving, &ramped).expect_err("an amplitude on a prescribed displacement");
    assert_eq!((e.code, e.where_.as_deref()), (ErrorCode::Unsupported, Some("amplitude")));
    // The same amplitude over a zero-valued support is fine, and scales the loads.
    moving.constraints = root();
    moving.loads = vec![Load::Traction { faces: "xmax".into(), t: [1e6, 0.0, 0.0] }];
    let res = run_step(&moving, &ramped).expect("an amplitude on the loads");
    assert!((res.scalars["load_total_x"] - 0.01 * 1e6 * libm::sin(2.0 * PI * t_end / 1e-3)).abs() <= 1e-6);
    // A NaN in the load table after t = 0 poisons the first solve, never the history.
    let Step::Implicit { amplitude, .. } = &mut ramped else { panic!() };
    *amplitude = Some(procedure::Amplitude::Table { t: vec![0.0, 1.0], value: vec![1.0, f64::NAN] });
    let e = run_step(&moving, &ramped).expect_err("a NaN load");
    assert_eq!(e.code, ErrorCode::SolveStalled);
    // A NaN initial velocity poisons the initial-acceleration solve.
    let kick = implicit_step(dt, t_end, 0.0, (0.0, 0.0), Some(vec![f64::NAN; mesh.n_nodes() * 3]), 1);
    assert_eq!(run_step(&p, &kick).expect_err("a NaN velocity").code, ErrorCode::SolveStalled);
    // A tie.
    let two = two_blocks(ElementKind::Hex8, [1, 1, 1], [1, 1, 1], [1.0, 1.0, 1.0], 0.0);
    let two_sets = sets_of(&two);
    let names = two_bodies();
    let mut tied = problem(&two, &two_sets, &names, Idealisation::Solid3d, Formulation::Full, Vec::new());
    tied.couplings = vec![bond(1e-9)];
    let e = run_step(&tied, &implicit_step(dt, t_end, 0.0, (0.0, 0.0), None, 1)).expect_err("a tie");
    assert_eq!((e.code, e.where_.as_deref()), (ErrorCode::Unsupported, Some("step.procedure")));
    assert!(e.cause.contains("'weld' ties two parts"), "{}", e.cause);
    // Every DOF held.
    let clamped = problem(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::Full,
        vec![fix("all", "all", [true, true, true], 0.0)],
    );
    let e = run_step(&clamped, &implicit_step(dt, t_end, 0.0, (0.0, 0.0), None, 1)).expect_err("nothing free");
    assert_eq!((e.code, e.where_.as_deref()), (ErrorCode::ModelIllPosed, Some("constraints")));
    // No density: the effective stiffness still factorises, the mass does not.
    let mut massless = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, root());
    massless.materials[0].rho = 0.0;
    let e = run_step(&massless, &implicit_step(dt, t_end, 0.0, (0.0, 0.0), None, 1)).expect_err("no mass");
    assert_eq!((e.code, e.where_.as_deref()), (ErrorCode::ModelIllPosed, Some("materials")));
    assert!(e.cause.contains("singular"), "{}", e.cause);
    // A negative modulus makes `K_eff` indefinite once the increment is long enough for the
    // stiffness to outweigh the mass.
    let mut soft = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, root());
    soft.materials[0].props = vec![-YOUNG, POISSON];
    let e = run_step(&soft, &implicit_step(1.0, 1.0, 0.0, (0.0, 0.0), None, 1)).expect_err("indefinite");
    assert_eq!(e.code, ErrorCode::SolveNotPositiveDefinite);
    // A law the checks cannot see fails inside the assembly.
    soft.materials[0].props = vec![YOUNG];
    let e = run_step(&soft, &implicit_step(dt, t_end, 0.0, (0.0, 0.0), None, 1)).expect_err("one prop");
    assert_eq!(e.code, ErrorCode::MaterialProps);
    // A Body without a material is caught by the well-posedness checks first.
    let mut bare = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, root());
    bare.material_of_block = vec![None];
    let e = run_step(&bare, &implicit_step(dt, t_end, 0.0, (0.0, 0.0), None, 1)).expect_err("no material");
    assert_eq!(e.code, ErrorCode::ModelNoMaterial);
}

/// The implicit Result is bit-identical at one and many threads: fields, scalars, reactions
/// and every retained frame.
#[test]
fn an_implicit_step_is_bit_identical_at_one_and_many_threads() {
    let many = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).max(2);
    let mesh = Structured { kind: ElementKind::Hex8, n: [8, 2, 2] }.box_([1.0, 0.1, 0.1]);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let held = vec![fix("root", "xmin", [true, true, true], 0.0)];
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::IncompatibleModes, held);
    p.loads = vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -1e5] }];
    let step = implicit_step(2e-4, 2e-3, -0.05, (10.0, 1e-5), None, 2);
    let run = |threads: usize| {
        pollster::block_on(procedure::run(&p, &step, &Pool::new(threads), None, None, &mut nop)).expect("solves")
    };
    let (one, par) = (run(1), run(many));
    assert_eq!(one.fields.keys().collect::<Vec<_>>(), par.fields.keys().collect::<Vec<_>>());
    for (name, a) in &one.fields {
        let differing = a.data.iter().zip(&par.fields[name].data).filter(|(x, y)| x.to_bits() != y.to_bits()).count();
        assert_eq!(differing, 0, "{name:?}: {differing} values differ at {many} threads");
    }
    for (k, v) in &one.scalars {
        assert_eq!(v.to_bits(), par.scalars[k].to_bits(), "scalar {k}");
    }
    assert_eq!(one.reactions, par.reactions);
    let (a, b) = (one.history.as_ref().unwrap(), par.history.as_ref().unwrap());
    assert_eq!(a.times, b.times);
    for (i, (x, y)) in a.values.iter().zip(&b.values).enumerate() {
        assert!(x.iter().zip(y).all(|(x, y)| x.to_bits() == y.to_bits()), "frame {i}");
    }
}

/// A nodal vector field of `dpn` components rotated by `r` (a 2D field lies in the xy plane).
fn rotate_field(r: &[[f64; 3]; 3], data: &[f64], dpn: usize) -> Vec<f64> {
    data.chunks_exact(dpn)
        .flat_map(|v| {
            let mut full = [0.0; 3];
            full[..dpn].copy_from_slice(v);
            rot_vec(r, full).into_iter().take(dpn)
        })
        .collect()
}

/// `R σ Rᵀ` for every entry of a Voigt field (`11,22,33,12,13,23`); `shear` is the factor the
/// off-diagonal entries are stored with — 1 for a stress, 2 for an engineering strain.
fn rotate_voigt(r: &[[f64; 3]; 3], f: &FieldData, shear: f64) -> Vec<f64> {
    assert_eq!(f.comps, VOIGT);
    let rt = transpose(r);
    f.data
        .chunks_exact(VOIGT)
        .flat_map(|s| {
            let t = [
                [s[0], s[3] / shear, s[4] / shear],
                [s[3] / shear, s[1], s[5] / shear],
                [s[4] / shear, s[5] / shear, s[2]],
            ];
            let m = mat3(r, &mat3(&t, &rt));
            [m[0][0], m[1][1], m[2][2], shear * m[0][1], shear * m[0][2], shear * m[1][2]]
        })
        .collect()
}

/// A structured block of `kind`, `n` cells per axis (the third ignored in 2D), `size` metres,
/// starting at `x = shift` so an axisymmetric radius is never zero.
fn block(kind: ElementKind, n: [usize; 3], size: [f64; 3], shift: f64) -> Mesh {
    Structured { kind, n }.build(|p| [shift + p[0] * size[0], p[1] * size[1], p[2] * size[2]])
}

/// The engine's own lattice mesher — with the Kuhn split for the simplex kinds, exactly as
/// `mesh.set` with `simplices` does — on the unit box (unit square for a 2D kind) shifted to
/// `x ∈ [1, 2]`, `n` cells per axis.
fn lattice_block(kind: ElementKind, n: usize) -> Mesh {
    let shape =
        if kind.dim() == 3 { Shape::Box { size: [1.0; 3] } } else { Shape::Sheet { sketch: Sketch::rect(1.0, 1.0) } };
    let solid = Solid::evaluate(&shape).expect("a box evaluates");
    let quadratic = kind.n_nodes() > kind.n_corners();
    let grid = lattice(&solid, None, Some([n as u32; 3]), quadratic).expect("a box lattices");
    let mut m = match kind {
        ElementKind::Tet4 | ElementKind::Tet10 | ElementKind::Tri3 | ElementKind::Tri6 => split_to_simplices(&grid),
        _ => grid,
    };
    shift_x(&mut m, 1.0);
    m
}

/// The free triangle mesher on the unit square at about `size`, shifted to `x ∈ [1, 2]`.
fn free_square(quadratic: bool, size: f64) -> Mesh {
    let mut m = free(&Sketch::rect(1.0, 1.0), size, quadratic, &[]).expect("a square meshes");
    shift_x(&mut m, 1.0);
    m
}

fn shift_x(m: &mut Mesh, by: f64) {
    for x in m.coords.iter_mut().step_by(3) {
        *x += by;
    }
}

/// A nodal temperature that varies in every direction, above a reference of 293.15 K.
fn varying_temperature(mesh: &Mesh) -> Vec<f64> {
    (0..mesh.n_nodes())
        .map(|n| {
            let x = mesh.node(n as u32);
            293.15 + 25.0 * x[0] + 10.0 * x[1] - 5.0 * x[2]
        })
        .collect()
}

/// Every structural Load kind at once, in the frame `r`, on a geometry scaled by `s` with the
/// total forces scaled by `force`. A traction and a pressure are per area, so their totals
/// follow the geometry on their own; a nodal force carries `force` itself; gravity, a force
/// per volume, carries `1/s` whatever the idealisation. In 2D the out-of-plane components
/// are dropped.
fn every_load(r: &[[f64; 3]; 3], s: f64, force: f64, three: bool) -> Vec<Load> {
    let planar = |v: [f64; 3]| if three { v } else { [v[0], v[1], 0.0] };
    let nodes = if three { "zmax" } else { "ymax" };
    vec![
        Load::Traction { faces: "xmax".into(), t: planar(rot_vec(r, [3e5, -2e5, 1e5])) },
        Load::Pressure { faces: "ymin".into(), p: 2e5 },
        Load::NodalForce { nodes: nodes.into(), f: planar(rot_vec(r, [1e3, 2e3, -1.5e3]).map(|x| x * force)) },
        Load::Gravity { g: planar(rot_vec(r, [0.0, -9.81, 2.0]).map(|x| x / s)) },
    ]
}

/// A Problem with every Load in frame `r` at geometric scale `s` and force scale `force`, the
/// `xmin` face clamped, the nodal temperature `t`, and any `extra` Constraints.
#[allow(clippy::too_many_arguments)]
fn loaded<'a>(
    mesh: &'a Mesh,
    sets: &'a BTreeMap<String, ResolvedSet>,
    bodies: &'a [String],
    id: Idealisation,
    form: Formulation,
    r: &[[f64; 3]; 3],
    s: f64,
    force: f64,
    t: &[f64],
    extra: Vec<Constraint>,
) -> Problem<'a> {
    let mut constraints = vec![fix("root", "xmin", [true, true, true], 0.0)];
    constraints.extend(extra);
    let mut p = problem(mesh, sets, bodies, id, form, constraints);
    p.loads = every_load(r, s, force, mesh.dim == 3);
    p.temperature = Some((t.to_vec(), 293.15));
    p
}

fn applied_totals(res: &StepResult) -> [f64; 3] {
    ["x", "y", "z"].map(|a| res.scalars[&format!("applied_total_{a}")])
}

fn constraint_totals(res: &StepResult) -> Vec<f64> {
    res.reactions.iter().flat_map(|(_, r)| *r).collect()
}

/// The six structural cases the frame and scaling tests run: both 3D families at both orders
/// and every 2D idealisation, with the incompatible-mode formulation where it applies.
fn frame_cases() -> [(ElementKind, Idealisation, Formulation); 6] {
    [
        (ElementKind::Hex8, Idealisation::Solid3d, Formulation::IncompatibleModes),
        (ElementKind::Hex20, Idealisation::Solid3d, Formulation::Full),
        (ElementKind::Tet10, Idealisation::Solid3d, Formulation::Full),
        (ElementKind::Quad4, Idealisation::PlaneStress { thickness: THICKNESS }, Formulation::IncompatibleModes),
        (ElementKind::Quad8, Idealisation::PlaneStrain, Formulation::Full),
        (ElementKind::Tri6, Idealisation::PlaneStrain, Formulation::Full),
    ]
}

/// The round-off gate of the exact properties. Two solves of the same problem in different
/// frames, scales or load groups go through the same direct factorisation of matrices whose
/// condition number is about 1e5 on these blocks, so they may differ by a few times
/// `κ · ε ≈ 1e-11`; every test reports what it measures, and they measure about 1e-12.
const EXACT_TOL: f64 = 1e-10;

/// The gate of the two reciprocity tests, which compare two solves through the *same*
/// factorisation: only the forward and back substitutions differ, so the answers agree to
/// about `n ε ≈ 1e-13`; they measure below 1e-15.
const RECIPROCITY_TOL: f64 = 1e-13;

/// K3: frame invariance. The model rotated by a general `R` — geometry, tractions, nodal
/// forces and gravity alike — gives `u' = R u`, `σ' = R σ Rᵀ`, `ε' = R ε Rᵀ`, rotated reactions
/// and applied totals, and unchanged invariants (von Mises, principal stresses), to round-off.
///
/// Fails on any hard-coded axis, on a Voigt rotation or shear-ordering slip in `B` or `D`
/// (the kind the orthotropic review caught), on a face normal or a traction taken in the wrong
/// frame, and on a thermal strain that is not isotropic. Axisymmetry is not frame-invariant
/// by construction (its axis is the frame), so it is not here.
#[test]
fn a_rotated_model_gives_rotated_displacements_and_stresses() {
    let mut worst = 0.0f64;
    for (kind, id, form) in frame_cases() {
        let three = kind.dim() == 3;
        let mesh = block(kind, [4, 2, 2], [1.0, 0.5, 0.5], 0.0);
        let r = if three { rotation(0.3, -0.7, 1.1) } else { rotation(0.0, 0.0, 0.9) };
        let rotated = rotate_mesh(&mesh, &r);
        let t = varying_temperature(&mesh);
        let (sets, rsets) = (sets_of(&mesh), sets_of(&rotated));
        let bodies = one_body();
        let p = loaded(&mesh, &sets, &bodies, id.clone(), form, &IDENTITY, 1.0, 1.0, &t, vec![]);
        let q = loaded(&rotated, &rsets, &bodies, id.clone(), form, &r, 1.0, 1.0, &t, vec![]);
        let step = static_step(SolveOptions::default());
        let a = run_step(&p, &step).expect("the block solves");
        let b = run_step(&q, &step).expect("the rotated block solves");
        let label = format!("{kind:?} {id:?}");
        for field in [Field::Displacement, Field::Reaction] {
            let want = rotate_field(&r, &a.fields[&field].data, a.fields[&field].comps);
            worst = worst.max(gate(&format!("{label} {field:?}"), &b.fields[&field].data, &want, EXACT_TOL));
        }
        for (field, shear) in [(Field::Stress, 1.0), (Field::StressUnaveraged, 1.0), (Field::Strain, 2.0)] {
            let want = rotate_voigt(&r, &a.fields[&field], shear);
            worst = worst.max(gate(&format!("{label} {field:?}"), &b.fields[&field].data, &want, EXACT_TOL));
        }
        for field in [Field::VonMises, Field::Principal] {
            let want = &a.fields[&field].data;
            worst = worst.max(gate(&format!("{label} {field:?}"), &b.fields[&field].data, want, EXACT_TOL));
        }
        let want = rot_vec(&r, applied_totals(&a));
        worst = worst.max(gate(&format!("{label} applied"), &applied_totals(&b), &want, EXACT_TOL));
        let want = rotate_field(&r, &constraint_totals(&a), 3);
        worst = worst.max(gate(&format!("{label} reactions"), &constraint_totals(&b), &want, EXACT_TOL));
        // The natural frequencies are frame-invariant too. The subspace iteration stops when
        // no eigenvalue moves by more than 1e-10 relative in a sweep and converges linearly,
        // so each frame's eigenvalues are within a small multiple of 1e-10 of the limit and
        // the two frames' frequencies (√λ, which halves the relative error) agree to 1e-9.
        let modal = Step::Modal { n_modes: 4, shift: None, solver: SolveOptions::default() };
        let (fa, fb) = (run_step(&p, &modal).expect("modal"), run_step(&q, &modal).expect("rotated modal"));
        gate(&format!("{label} frequencies"), &fb.frequencies, &fa.frequencies, 1e-9);
    }
    eprintln!("K3 frame invariance: worst relative disagreement {worst:e}");
}

/// K4: geometric scaling. The geometry scaled by `s` with the total loads scaled by `s²` (so
/// tractions and pressures unchanged, nodal forces `× s²`, gravity `× 1/s`, prescribed
/// displacements `× s`, temperatures unchanged) gives displacements `× s`, reactions `× s²`
/// and stresses and strains unchanged, from millimetre to kilometre blocks, to round-off.
/// Plane strain carries an implicit unit thickness that does not scale, so there the forces
/// and reactions go as `s`, not `s²` — the one exponent the idealisation changes.
///
/// Fails on any dimensional slip: a length used where an area belongs, a Jacobian determinant
/// missing from one integral, a thickness applied to one term and not another, a face measure
/// in the wrong power of `h`.
#[test]
fn a_scaled_model_scales_its_displacements_and_keeps_its_stresses() {
    let mut worst = 0.0f64;
    for (kind, id, form) in frame_cases() {
        let three = kind.dim() == 3;
        // the prescribed face must not share a node with the clamped one
        let dof = if three { [false, false, true] } else { [false, true, false] };
        let base = block(kind, [4, 2, 2], [1.0, 0.5, 0.5], 0.0);
        let t = varying_temperature(&base);
        let bodies = one_body();
        let sets = sets_of(&base);
        let lift = |s: f64| vec![fix("lift", "xmax", dof, 1e-4 * s)];
        let p = loaded(&base, &sets, &bodies, id.clone(), form, &IDENTITY, 1.0, 1.0, &t, lift(1.0));
        let step = static_step(SolveOptions::default());
        let a = run_step(&p, &step).expect("the block solves");
        for s in [1e-3, 1e3] {
            let force = if id == Idealisation::PlaneStrain { s } else { s * s };
            let mesh = block(kind, [4, 2, 2], [s, 0.5 * s, 0.5 * s], 0.0);
            let ssets = sets_of(&mesh);
            let id_s = match &id {
                Idealisation::PlaneStress { thickness } => Idealisation::PlaneStress { thickness: thickness * s },
                other => other.clone(),
            };
            let q = loaded(&mesh, &ssets, &bodies, id_s, form, &IDENTITY, s, force, &t, lift(s));
            let b = run_step(&q, &step).expect("the scaled block solves");
            let label = format!("{kind:?} {id:?} s={s:e}");
            let scaled = |f: Field, by: f64| a.fields[&f].data.iter().map(|x| x * by).collect::<Vec<f64>>();
            for (field, by) in [
                (Field::Displacement, s),
                (Field::Reaction, force),
                (Field::Stress, 1.0),
                (Field::StressUnaveraged, 1.0),
                (Field::Strain, 1.0),
                (Field::VonMises, 1.0),
                (Field::Principal, 1.0),
            ] {
                let want = scaled(field, by);
                worst = worst.max(gate(&format!("{label} {field:?}"), &b.fields[&field].data, &want, EXACT_TOL));
            }
            let want = applied_totals(&a).map(|x| x * force);
            worst = worst.max(gate(&format!("{label} applied"), &applied_totals(&b), &want, EXACT_TOL));
            let want: Vec<f64> = constraint_totals(&a).iter().map(|x| x * force).collect();
            worst = worst.max(gate(&format!("{label} reactions"), &constraint_totals(&b), &want, EXACT_TOL));
        }
    }
    eprintln!("K4 scaling: worst relative disagreement {worst:e}");
}

/// A one-node Set, for a point force.
fn node_set(sets: &mut BTreeMap<String, ResolvedSet>, name: &str, node: u32) {
    sets.insert(
        name.into(),
        ResolvedSet { kind: SetKind::Node, faces: Vec::new(), nodes: vec![node], elems: Vec::new() },
    );
}

/// The displacement field due to a unit force along `dir` on the one-node Set `at`, as the
/// Step reports it (three components per node whatever the dimension).
fn influence(p: &mut Problem<'_>, at: &str, dir: usize) -> FieldData {
    let mut f = [0.0; 3];
    f[dir] = 1.0;
    p.loads = vec![Load::NodalForce { nodes: at.into(), f }];
    run_step(p, &static_step(SolveOptions::default())).expect("a clamped block solves").fields[&Field::Displacement]
        .clone()
}

/// Maxwell–Betti on one Problem: `u_B·e_i` under a unit force `e_j` at A equals `u_A·e_j`
/// under a unit force `e_i` at B, for every pair of directions. The cross flexibility is
/// bounded by `√(f_AA f_BB)` (the flexibility matrix is positive definite), which is the
/// scale the disagreement is measured against. Returns the worst relative disagreement.
fn betti(p: &mut Problem<'_>, a: u32, b: u32, label: &str) -> f64 {
    let dpn = p.dofs_per_node();
    let from_a: Vec<FieldData> = (0..dpn).map(|j| influence(p, "A", j)).collect();
    let from_b: Vec<FieldData> = (0..dpn).map(|i| influence(p, "B", i)).collect();
    let at = |f: &FieldData, node: u32, c: usize| f.data[node as usize * f.comps + c];
    let mut worst = 0.0f64;
    for (j, ua) in from_a.iter().enumerate() {
        for (i, ub) in from_b.iter().enumerate() {
            let (ab, ba) = (at(ua, b, i), at(ub, a, j));
            let scale = (at(ua, a, j) * at(ub, b, i)).sqrt();
            let d = (ab - ba).abs() / scale;
            assert!(d <= RECIPROCITY_TOL, "{label} A{j} B{i}: {ab} vs {ba}, {d:e} of the flexibility bound");
            worst = worst.max(d);
        }
    }
    worst
}

/// K1: Maxwell–Betti reciprocity for every kind and idealisation, and across a bonded tie
/// whose slave mesh is finer than its master (every pairing a fractional projection).
///
/// Fails on any asymmetry: an element stiffness scattered into the wrong triangle, a
/// constraint elimination that keeps a coupling on one side only, a multipoint-constraint
/// transform that is not `Tᵀ K T` (the tie case), a load applied through a different operator
/// than the one solved.
#[test]
fn a_unit_force_at_a_moves_b_as_much_as_a_unit_force_at_b_moves_a() {
    let mut worst = 0.0f64;
    for kind in ALL_KINDS {
        let three = kind.dim() == 3;
        let mesh = block(kind, [4, 2, 2], [1.0, 0.5, 0.5], 1.0);
        let z = if three { 0.5 } else { 0.0 };
        let (a, b) = (node_at(&mesh, [2.0, 0.5, z]), node_at(&mesh, [1.5, 0.0, 0.5 * z]));
        let mut sets = sets_of(&mesh);
        node_set(&mut sets, "A", a);
        node_set(&mut sets, "B", b);
        let bodies = one_body();
        for id in idealisations(kind) {
            let root = vec![fix("root", "xmin", [true; 3], 0.0)];
            let mut p = problem(&mesh, &sets, &bodies, id.clone(), Formulation::IncompatibleModes, root);
            worst = worst.max(betti(&mut p, a, b, &format!("{kind:?} {id:?}")));
        }
    }
    let mesh = two_blocks(ElementKind::Hex8, [2, 2, 2], [3, 3, 3], [0.5, 0.5, 0.5], 0.0);
    let (a, b) = (node_at(&mesh, [1.0, 0.5, 0.5]), node_at(&mesh, [0.25, 0.0, 0.25]));
    let mut sets = sets_of(&mesh);
    node_set(&mut sets, "A", a);
    node_set(&mut sets, "B", b);
    let bodies = two_bodies();
    let root = vec![fix("root", "a.xmin", [true; 3], 0.0)];
    let mut p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, root);
    p.couplings = vec![bond(1e-9)];
    worst = worst.max(betti(&mut p, a, b, "tied"));
    eprintln!("K1 reciprocity: worst relative disagreement {worst:e}");
}

fn add(a: &[f64], b: &[f64]) -> Vec<f64> {
    a.iter().zip(b).map(|(x, y)| x + y).collect()
}

/// Every retained history frame of a Result, concatenated.
fn frames(r: &StepResult) -> Vec<f64> {
    r.history.as_ref().expect("the Step retains frames").values.concat()
}

/// `both + none == one + two` on every field that is linear in the loads, on the applied
/// totals, the per-Constraint reactions and every retained history frame; returns the worst
/// relative disagreement. Von Mises and principal stresses are not linear and are skipped.
fn affine(both: &StepResult, none: &StepResult, one: &StepResult, two: &StepResult, label: &str) -> f64 {
    let mut worst = 0.0f64;
    for (field, f) in &both.fields {
        if *field == Field::VonMises || *field == Field::Principal {
            continue;
        }
        let got = add(&f.data, &none.fields[field].data);
        let want = add(&one.fields[field].data, &two.fields[field].data);
        worst = worst.max(gate(&format!("{label} {field:?}"), &got, &want, EXACT_TOL));
    }
    let got = add(&applied_totals(both), &applied_totals(none));
    let want = add(&applied_totals(one), &applied_totals(two));
    worst = worst.max(gate(&format!("{label} applied"), &got, &want, EXACT_TOL));
    let got = add(&constraint_totals(both), &constraint_totals(none));
    let want = add(&constraint_totals(one), &constraint_totals(two));
    worst = worst.max(gate(&format!("{label} reactions"), &got, &want, EXACT_TOL));
    if let Some(h) = &both.history {
        assert_eq!(h.times, none.history.as_ref().expect("frames").times);
        let (got, want) = (add(&frames(both), &frames(none)), add(&frames(one), &frames(two)));
        worst = worst.max(gate(&format!("{label} history"), &got, &want, EXACT_TOL));
    }
    worst
}

/// The four runs of a structural superposition check on `step`: all of `loads`, none, the
/// first `split` of them, the rest.
fn superpose(p: &mut Problem<'_>, step: &Step, loads: &[Load], split: usize, label: &str) -> f64 {
    let mut run = |l: &[Load]| {
        p.loads = l.to_vec();
        run_step(p, step).expect("every load group solves")
    };
    let (both, none, one, two) = (run(loads), run(&[]), run(&loads[..split]), run(&loads[split..]));
    affine(&both, &none, &one, &two, label)
}

/// The same four runs of a heat superposition check: `base` is in every run (a convection
/// film is part of the operator, so it cannot be a load group), `groups` are the two groups.
fn superpose_heat(p: &mut Problem<'_>, step: &Step, base: &[HeatLoad], groups: [&[HeatLoad]; 2], label: &str) -> f64 {
    let mut run = |extra: &[&[HeatLoad]]| {
        p.heat_loads = base.iter().chain(extra.iter().flat_map(|g| g.iter())).cloned().collect();
        run_step(p, step).expect("every heat load group conducts")
    };
    let (both, none, one, two) = (run(&groups), run(&[]), run(&groups[..1]), run(&groups[1..]));
    affine(&both, &none, &one, &two, label)
}

/// K2: superposition. `u(L₁ ∪ L₂) + u(∅) = u(L₁) + u(L₂)` for every linear procedure — the
/// affine form, so a prescribed displacement, a temperature field, a transient's initial
/// state and a convection ambient (which all live in the `u(∅)` answer) are allowed and
/// exercised. Runs the static Step plain, amplitude-stepped and across a bonded tie, explicit
/// dynamics, and steady and transient heat.
///
/// Fails if anything on a linear path is secretly nonlinear or stateful: a load assembled
/// with a sign that depends on what else is applied, a solver reusing a stale factorisation,
/// a history buffer not reset between increments, an amplitude applied to one load and not
/// another.
#[test]
fn every_linear_procedure_superposes_its_loads() {
    let mut worst = 0.0f64;
    let mesh = block(ElementKind::Hex8, [4, 2, 2], [1.0, 0.5, 0.5], 0.0);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let t = varying_temperature(&mesh);
    let lift = vec![fix("lift", "xmax", [false, false, true], 1e-4)];
    let mut p = loaded(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::IncompatibleModes,
        &IDENTITY,
        1.0,
        1.0,
        &t,
        lift,
    );
    let all = p.loads.clone();
    let dt_crit = critical_step(&p);
    let ramp = procedure::Amplitude::Table { t: vec![0.0, 1.0, 2.0], value: vec![0.0, 1.0, 0.5] };
    let steps = [
        static_step(SolveOptions::default()),
        ramped_step(ramp, 0.5, 2.0, 1),
        Step::Explicit { t_end: 18.0 * dt_crit, dt_factor: 0.9, initial_velocity: None, output_every: 5 },
    ];
    for step in &steps {
        worst = worst.max(superpose(&mut p, step, &all, 2, step.name()));
    }

    let tied = two_blocks(ElementKind::Hex8, [2, 2, 2], [3, 3, 3], [0.5, 0.5, 0.5], 0.0);
    let tsets = sets_of(&tied);
    let two = two_bodies();
    let root = vec![fix("root", "a.xmin", [true; 3], 0.0)];
    let mut q = problem(&tied, &tsets, &two, Idealisation::Solid3d, Formulation::Full, root);
    q.couplings = vec![bond(1e-9)];
    let loads =
        [Load::Traction { faces: "b.xmax".into(), t: [1e5, -2e5, 3e5] }, Load::Gravity { g: [0.0, 0.0, -9.81] }];
    worst = worst.max(superpose(&mut q, &steps[0], &loads, 1, "tied static"));

    let cold = vec![hold("cold", "xmin", 300.0)];
    let mut h =
        heat_problem(&mesh, &sets, &bodies, Idealisation::Solid3d, conductor(45.0, 7800.0, 460.0), cold, vec![]);
    let base = [HeatLoad::Convection { faces: "xmax".into(), h: 50.0, t_inf: 350.0 }];
    let flux = [HeatLoad::Flux { faces: "ymax".into(), q: 2000.0 }];
    let source = [HeatLoad::Source { bodies: one_body(), q: 5e4 }];
    let transient = Step::HeatTransient {
        dt: 0.5,
        t_end: 2.0,
        theta: 0.5,
        initial: 300.0,
        output_every: 1,
        amplitude: None,
        solver: SolveOptions::default(),
        control: NonlinearControl::default(),
    };
    for step in [steady(), transient] {
        worst = worst.max(superpose_heat(&mut h, &step, &base, [&flux, &source], step.name()));
    }
    eprintln!("K2 superposition: worst relative disagreement {worst:e}");
}

/// A one-face Set, for a unit flux.
fn face_set(sets: &mut BTreeMap<String, ResolvedSet>, name: &str, mesh: &Mesh, face: Face) {
    let mut nodes: Vec<u32> = mesh.face_nodes(face).collect();
    nodes.sort_unstable();
    let set = ResolvedSet { kind: SetKind::Face, faces: vec![face], nodes, elems: Vec::new() };
    sets.insert(name.into(), set);
}

/// The heat cases of the frame, reciprocity and unit tests: both 3D families and two 2D
/// idealisations.
fn heat_cases() -> [(ElementKind, Idealisation); 4] {
    [
        (ElementKind::Hex8, Idealisation::Solid3d),
        (ElementKind::Tet10, Idealisation::Solid3d),
        (ElementKind::Quad8, Idealisation::PlaneStrain),
        (ElementKind::Tri6, Idealisation::PlaneStress { thickness: THICKNESS }),
    ]
}

/// K6: reciprocity of the conduction operator. With the same held face and the same
/// convection film, the temperature field `T_B` due to a unit flux on face A and `T_A` due to
/// a unit flux on face B satisfy `f_A · T_B = f_B · T_A`, where `f` is the assembled flux
/// vector; the cross term is bounded by `√((f_A·T_A)(f_B·T_B))`, the scale it is gated on.
///
/// Fails on any asymmetry in the conductivity or film assembly, on a flux integrated with a
/// different face measure than the film, and on a constraint elimination that drops a
/// coupling on one side.
#[test]
fn a_unit_flux_on_a_warms_b_as_much_as_a_unit_flux_on_b_warms_a() {
    let mut worst = 0.0f64;
    for (kind, id) in heat_cases() {
        let mesh = block(kind, [4, 2, 2], [1.0, 0.5, 0.5], 1.0);
        let top = if kind.dim() == 3 { "zmax" } else { "ymax" };
        let (fa, fb) = (mesh.face_sets[top][0], mesh.face_sets["xmax"][mesh.face_sets["xmax"].len() - 1]);
        let mut sets = sets_of(&mesh);
        face_set(&mut sets, "A", &mesh, fa);
        face_set(&mut sets, "B", &mesh, fb);
        let bodies = one_body();
        let cold = vec![hold("cold", "xmin", 0.0)];
        let mut p = heat_problem(&mesh, &sets, &bodies, id.clone(), conductor(45.0, 7800.0, 460.0), cold, vec![]);
        let pat = pattern(&mesh, 1);
        let mut solve_with = |set: &str| {
            let film = HeatLoad::Convection { faces: "ymin".into(), h: 30.0, t_inf: 0.0 };
            p.heat_loads = vec![film, HeatLoad::Flux { faces: set.into(), q: 1.0 }];
            let f = heat::assemble(&p, &pat, &Mpc::none()).expect("assembles").f;
            (f, temperature_of(&run_step(&p, &steady()).expect("conducts")))
        };
        let ((fa, ta), (fb, tb)) = (solve_with("A"), solve_with("B"));
        let dot = |x: &[f64], y: &[f64]| x.iter().zip(y).map(|(a, b)| a * b).sum::<f64>();
        let (ab, ba) = (dot(&fa, &tb), dot(&fb, &ta));
        let d = (ab - ba).abs() / (dot(&fa, &ta) * dot(&fb, &tb)).sqrt();
        assert!(d <= RECIPROCITY_TOL, "{kind:?} {id:?}: {ab} vs {ba}, {d:e} of the bound");
        worst = worst.max(d);
    }
    eprintln!("K6 heat reciprocity: worst relative disagreement {worst:e}");
}

/// Every field, applied total, per-Constraint reaction and history frame of two Results that
/// must be the same numbers; returns the worst relative disagreement.
fn same_result(a: &StepResult, b: &StepResult, label: &str) -> f64 {
    let mut worst = 0.0f64;
    for (field, f) in &a.fields {
        worst = worst.max(gate(&format!("{label} {field:?}"), &b.fields[field].data, &f.data, EXACT_TOL));
    }
    worst = worst.max(gate(&format!("{label} applied"), &applied_totals(b), &applied_totals(a), EXACT_TOL));
    worst = worst.max(gate(&format!("{label} reactions"), &constraint_totals(b), &constraint_totals(a), EXACT_TOL));
    if let Some(h) = &a.history {
        assert_eq!(h.times, b.history.as_ref().expect("frames").times);
        worst = worst.max(gate(&format!("{label} history"), &frames(b), &frames(a), EXACT_TOL));
    }
    worst
}

/// The heat Problem of the frame and determinism tests: a held face, a convecting face, a
/// flux and a volumetric source.
fn heated<'a>(
    mesh: &'a Mesh,
    sets: &'a BTreeMap<String, ResolvedSet>,
    bodies: &'a [String],
    id: Idealisation,
) -> Problem<'a> {
    let loads = vec![
        HeatLoad::Convection { faces: "xmax".into(), h: 50.0, t_inf: 350.0 },
        HeatLoad::Flux { faces: "ymax".into(), q: 2000.0 },
        HeatLoad::Source { bodies: bodies.to_vec(), q: 5e4 },
    ];
    let cold = vec![hold("cold", "xmin", 300.0)];
    heat_problem(mesh, sets, bodies, id, conductor(45.0, 7800.0, 460.0), cold, loads)
}

fn transient_step() -> Step {
    Step::HeatTransient {
        dt: 0.5,
        t_end: 1.0,
        theta: 0.5,
        initial: 300.0,
        output_every: 1,
        amplitude: None,
        solver: SolveOptions::default(),
        control: NonlinearControl::default(),
    }
}

/// K7: heat frame invariance. Temperature is a scalar, so the model rotated by a general `R`
/// gives the same nodal temperatures, reaction powers and history, steady and transient, to
/// round-off.
///
/// Fails on a conductivity or film integral that reads a coordinate direction, on a face
/// measure taken from one component of a normal, and on any axis-dependent capacity term.
#[test]
fn a_rotated_heat_model_gives_the_same_temperatures() {
    let mut worst = 0.0f64;
    for (kind, id) in heat_cases() {
        let mesh = block(kind, [4, 2, 2], [1.0, 0.5, 0.5], 0.0);
        let r = if kind.dim() == 3 { rotation(0.3, -0.7, 1.1) } else { rotation(0.0, 0.0, 0.9) };
        let rotated = rotate_mesh(&mesh, &r);
        let (sets, rsets) = (sets_of(&mesh), sets_of(&rotated));
        let bodies = one_body();
        let (p, q) = (heated(&mesh, &sets, &bodies, id.clone()), heated(&rotated, &rsets, &bodies, id.clone()));
        for step in [steady(), transient_step()] {
            let (a, b) = (run_step(&p, &step).expect("conducts"), run_step(&q, &step).expect("rotated conducts"));
            worst = worst.max(same_result(&a, &b, &format!("{kind:?} {id:?} {}", step.name())));
        }
    }
    eprintln!("K7 heat frame invariance: worst relative disagreement {worst:e}");
}

/// A Model built by dispatching `cmds` (JSON, one Command each) into a fresh Engine.
fn engine_with(cmds: &[&str]) -> Engine {
    let mut e = Engine::new(None, Box::new(NoClock), 2);
    for c in cmds {
        let cmd: Command = serde_json::from_str(c).expect("valid Command JSON");
        let ack = pollster::block_on(e.dispatch(cmd, &mut nop));
        assert!(ack.is_ok(), "{c}: {ack:?}");
    }
    e
}

/// K5: unit invariance. The same model authored in millimetres, megapascals, kilonewtons and
/// tonnes — lengths, stresses, forces, densities, accelerations, conductivities, fluxes,
/// films, sources and Celsius temperatures — and in SI has the same Model hash and
/// bit-identical displacements, stresses, reactions and temperatures.
///
/// Fails on a conversion applied twice or not at all in any Command's apply arm, on a
/// quantity stored in its display unit rather than SI, and on a unit factor that is not the
/// correctly rounded SI value (which would change the hash without changing the physics).
#[test]
fn a_model_authored_in_millimetres_hashes_and_solves_like_one_in_metres() {
    let si = [
        r#"{"cmd":"model.new","name":"units"}"#,
        r#"{"cmd":"geometry.addBox","name":"beam","size":["1 m","0.1 m","0.1 m"]}"#,
        r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3","alpha":"1.2e-5 1/K","k":"45 W/(m K)","cp":"460 J/(kg K)"}"#,
        r#"{"cmd":"material.assign","material":"steel","bodies":["beam"]}"#,
        r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"0.05 m"},"order":1}"#,
        r#"{"cmd":"constraint.fix","name":"root","on":"beam.xmin"}"#,
        r#"{"cmd":"load.traction","name":"tip","on":"beam.xmax","total":["0 N","0 N","-1000 N"]}"#,
        r#"{"cmd":"load.pressure","name":"top","on":"beam.zmax","value":"200000 Pa"}"#,
        r#"{"cmd":"load.gravity","name":"g","g":["0 m/s^2","0 m/s^2","-9.81 m/s^2"]}"#,
        r#"{"cmd":"load.temperature","name":"warm","bodies":["beam"],"value":"373.15 K"}"#,
        r#"{"cmd":"constraint.temperature","name":"cold","on":"beam.xmin","value":"273.15 K"}"#,
        r#"{"cmd":"load.heatFlux","name":"flux","on":"beam.ymax","q":"1000 W/m^2"}"#,
        r#"{"cmd":"load.convection","name":"film","on":"beam.xmax","h":"25 W/(m^2 K)","tInf":"300 K"}"#,
        r#"{"cmd":"load.heatSource","name":"src","bodies":["beam"],"q":"50000 W/m^3"}"#,
        r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["root"],"loads":["tip","top","g","warm"]}"#,
        r#"{"cmd":"step.add","name":"heat","procedure":"heat-steady","constraints":["cold"],"loads":["flux","film","src"]}"#,
        r#"{"cmd":"solve.run","step":"static"}"#,
        r#"{"cmd":"solve.run","step":"heat"}"#,
    ];
    let mm = [
        r#"{"cmd":"model.new","name":"units"}"#,
        r#"{"cmd":"geometry.addBox","name":"beam","size":["1000 mm","100 mm","100 mm"]}"#,
        r#"{"cmd":"material.add","name":"steel","E":"210000 MPa","nu":0.3,"rho":"7.85e-9 t/mm^3","alpha":"1.2e-5 1/K","k":"0.045 W/(mm K)","cp":"460000 J/(t K)"}"#,
        r#"{"cmd":"material.assign","material":"steel","bodies":["beam"]}"#,
        r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"50 mm"},"order":1}"#,
        r#"{"cmd":"constraint.fix","name":"root","on":"beam.xmin"}"#,
        r#"{"cmd":"load.traction","name":"tip","on":"beam.xmax","total":["0 kN","0 kN","-1 kN"]}"#,
        r#"{"cmd":"load.pressure","name":"top","on":"beam.zmax","value":"0.2 MPa"}"#,
        r#"{"cmd":"load.gravity","name":"g","g":["0 mm/s^2","0 mm/s^2","-9810 mm/s^2"]}"#,
        r#"{"cmd":"load.temperature","name":"warm","bodies":["beam"],"value":"100 degC"}"#,
        r#"{"cmd":"constraint.temperature","name":"cold","on":"beam.xmin","value":"0 degC"}"#,
        r#"{"cmd":"load.heatFlux","name":"flux","on":"beam.ymax","q":"0.001 W/mm^2"}"#,
        r#"{"cmd":"load.convection","name":"film","on":"beam.xmax","h":"2.5e-5 W/(mm^2 K)","tInf":"300 K"}"#,
        r#"{"cmd":"load.heatSource","name":"src","bodies":["beam"],"q":"5e-5 W/mm^3"}"#,
        r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["root"],"loads":["tip","top","g","warm"]}"#,
        r#"{"cmd":"step.add","name":"heat","procedure":"heat-steady","constraints":["cold"],"loads":["flux","film","src"]}"#,
        r#"{"cmd":"solve.run","step":"static"}"#,
        r#"{"cmd":"solve.run","step":"heat"}"#,
    ];
    let (a, b) = (engine_with(&si), engine_with(&mm));
    assert_eq!(
        a.model_hash(),
        b.model_hash(),
        "the SI Model differs from the millimetre one:\n{:#?}\n{:#?}",
        a.model(),
        b.model()
    );
    for (step, field) in [
        ("static", Field::Displacement),
        ("static", Field::Stress),
        ("static", Field::Reaction),
        ("heat", Field::Temperature),
        ("heat", Field::Reaction),
    ] {
        let (x, y) = (a.field(Some(step), field).expect("solved"), b.field(Some(step), field).expect("solved"));
        let differing = x.data.iter().zip(&y.data).filter(|(p, q)| p.to_bits() != q.to_bits()).count();
        assert_eq!(differing, 0, "{step} {field:?}: {differing} of {} values differ between mm and m", x.data.len());
    }
}

/// Bit-for-bit equality of two Results: every field, scalar, reaction, frequency, mode and
/// history frame.
fn assert_bitwise(a: &StepResult, b: &StepResult, label: &str) {
    let bits = |v: &[f64]| v.iter().map(|x| x.to_bits()).collect::<Vec<u64>>();
    assert_eq!(a.fields.keys().collect::<Vec<_>>(), b.fields.keys().collect::<Vec<_>>(), "{label}");
    for (field, f) in &a.fields {
        assert_eq!(bits(&f.data), bits(&b.fields[field].data), "{label} {field:?}");
    }
    for (k, v) in &a.scalars {
        assert_eq!(v.to_bits(), b.scalars[k].to_bits(), "{label} scalar {k}");
    }
    assert_eq!(a.reactions, b.reactions, "{label} reactions");
    assert_eq!(bits(&a.frequencies), bits(&b.frequencies), "{label} frequencies");
    assert_eq!(a.modes.len(), b.modes.len(), "{label} modes");
    for (i, (m, n)) in a.modes.iter().zip(&b.modes).enumerate() {
        assert_eq!(bits(&m.data), bits(&n.data), "{label} mode {}", i + 1);
    }
    let history = |r: &StepResult| r.history.as_ref().map(|h| (bits(&h.times), bits(&h.values.concat())));
    assert_eq!(history(a), history(b), "{label} history");
}

/// K9 (A8 extended): every procedure — static, modal, explicit, steady and transient heat —
/// is bit-identical at one and many threads, in every field, scalar, reaction, frequency,
/// mode and retained frame.
///
/// Fails on any reduction whose order depends on the thread count: a parallel scatter, a
/// chunk size read from the pool, a dot product summed per thread.
#[test]
fn every_procedure_is_bit_identical_at_one_and_many_threads() {
    let many = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).max(2);
    let mesh = block(ElementKind::Hex8, [4, 2, 2], [1.0, 0.5, 0.5], 0.0);
    let sets = sets_of(&mesh);
    let bodies = one_body();
    let t = varying_temperature(&mesh);
    let sp = loaded(
        &mesh,
        &sets,
        &bodies,
        Idealisation::Solid3d,
        Formulation::IncompatibleModes,
        &IDENTITY,
        1.0,
        1.0,
        &t,
        vec![],
    );
    let hp = heated(&mesh, &sets, &bodies, Idealisation::Solid3d);
    let dt_crit = critical_step(&sp);
    let runs: [(&Problem<'_>, Step); 5] = [
        (&sp, static_step(SolveOptions::default())),
        (&sp, Step::Modal { n_modes: 4, shift: None, solver: SolveOptions::default() }),
        (&sp, Step::Explicit { t_end: 18.0 * dt_crit, dt_factor: 0.9, initial_velocity: None, output_every: 5 }),
        (&hp, steady()),
        (&hp, transient_step()),
    ];
    for (p, step) in &runs {
        let run = |threads: usize| {
            pollster::block_on(procedure::run(p, step, &Pool::new(threads), None, None, &mut nop)).expect("solves")
        };
        assert_bitwise(&run(1), &run(many), step.name());
    }
}

// ------------------------------------------- mesh independence and refinement rates (K8, D4)

/// K8: mesh independence of exact fields. The patch test A1 runs on the engine's own meshers
/// — the lattice for every kind (with the Kuhn split for the simplex kinds), interior nodes
/// pushed off the grid, and the free triangle mesher at both orders — so a mesher whose
/// connectivity, node ordering or face sets are not conforming cannot pass.
#[test]
fn every_mesher_passes_the_patch_test_for_every_kind() {
    let mut meshes: Vec<(String, Mesh)> = ALL_KINDS
        .iter()
        .map(|&kind| {
            let mut m = lattice_block(kind, 2);
            perturb_interior(&mut m, 0.075, 7);
            straighten(&mut m);
            (format!("lattice {kind:?}"), m)
        })
        .collect();
    for quadratic in [false, true] {
        meshes.push((format!("free quadratic={quadratic}"), free_square(quadratic, 0.3)));
    }
    for (label, mesh) in &meshes {
        let sets = sets_of(mesh);
        for id in idealisations(mesh.kind_of(0)) {
            let axi = id == Idealisation::Axisymmetric;
            for (i, e) in patch_modes(&id).into_iter().enumerate() {
                // constant γ_rz is not an axisymmetric equilibrium state (see A1)
                if axi && i == 2 {
                    continue;
                }
                patch_check(mesh, &sets, &id, &e, &format!("{label} {id:?}"));
            }
        }
    }
}

/// A harmonic potential `φ` for the manufactured solutions: `u = ∇φ` solves Navier's
/// equations with no body force (`div u = Δφ = 0`, `Δu = ∇Δφ = 0`) in every idealisation,
/// and `T = φ` solves Laplace's equation.
#[derive(Clone, Copy, PartialEq)]
enum Harmonic {
    /// `sin x cosh y`, harmonic in the plane.
    Plane,
    /// `sin x sin y cosh(√2 z)`, harmonic in space.
    Solid,
    /// `r⁴ − 8 r² z² + 8/3 z⁴`, harmonic in space and independent of the angle; a quartic, so
    /// quadratic elements do not reproduce it and a rate can be observed.
    Axi,
}

/// `φ`, `∇φ` and `∇∇φ` at `x` (`x = (r, z)` for the axisymmetric potential).
fn harmonic(h: Harmonic, x: [f64; 3]) -> (f64, [f64; 3], [[f64; 3]; 3]) {
    match h {
        Harmonic::Plane => {
            let (s, c, ch, sh) = (libm::sin(x[0]), libm::cos(x[0]), libm::cosh(x[1]), libm::sinh(x[1]));
            (s * ch, [c * ch, s * sh, 0.0], [[-s * ch, c * sh, 0.0], [c * sh, s * ch, 0.0], [0.0; 3]])
        }
        Harmonic::Solid => {
            let k = std::f64::consts::SQRT_2;
            let (sx, cx, sy, cy) = (libm::sin(x[0]), libm::cos(x[0]), libm::sin(x[1]), libm::cos(x[1]));
            let (ch, sh) = (libm::cosh(k * x[2]), libm::sinh(k * x[2]));
            let phi = sx * sy * ch;
            let g = [cx * sy * ch, sx * cy * ch, k * sx * sy * sh];
            let hs = [
                [-phi, cx * cy * ch, k * cx * sy * sh],
                [cx * cy * ch, -phi, k * sx * cy * sh],
                [k * cx * sy * sh, k * sx * cy * sh, 2.0 * phi],
            ];
            (phi, g, hs)
        }
        Harmonic::Axi => {
            let (r, z) = (x[0], x[1]);
            let phi = r * r * r * r - 8.0 * r * r * z * z + 8.0 / 3.0 * z * z * z * z;
            let g = [4.0 * r * r * r - 16.0 * r * z * z, -16.0 * r * r * z + 32.0 / 3.0 * z * z * z, 0.0];
            let hs = [
                [12.0 * r * r - 16.0 * z * z, -32.0 * r * z, 0.0],
                [-32.0 * r * z, -16.0 * r * r + 32.0 * z * z, 0.0],
                [0.0; 3],
            ];
            (phi, g, hs)
        }
    }
}

fn harmonic_of(id: &Idealisation) -> Harmonic {
    match id {
        Idealisation::Solid3d => Harmonic::Solid,
        Idealisation::Axisymmetric => Harmonic::Axi,
        Idealisation::PlaneStrain | Idealisation::PlaneStress { .. } => Harmonic::Plane,
    }
}

/// The exact displacement `∇φ` and its engineering Voigt strain `∇∇φ` — with the hoop strain
/// `u_r / r` in axisymmetry. In plane stress the thickness strain is `−ν/(1−ν)(ε₁₁+ε₂₂) = 0`
/// because `φ` is harmonic, so the six components are exact in every idealisation.
fn exact_u(h: Harmonic, x: [f64; 3]) -> ([f64; 3], [f64; VOIGT]) {
    let (_, g, hs) = harmonic(h, x);
    let mut e = [hs[0][0], hs[1][1], hs[2][2], 2.0 * hs[0][1], 2.0 * hs[0][2], 2.0 * hs[1][2]];
    if h == Harmonic::Axi {
        e[2] = g[0] / x[0];
    }
    (g, e)
}

/// A rule denser than the element's own, so no Gauss-point superconvergence flatters the H1
/// error: the 4-point Gauss–Legendre tensor rules on quadrilaterals and hexahedra, the 25- and
/// 125-point simplex rules on triangles and tetrahedra.
fn error_rule(kind: ElementKind) -> (Vec<[f64; 3]>, Vec<f64>) {
    let gl = gauss_legendre(4);
    let mut points = Vec::new();
    let mut weights = Vec::new();
    match kind {
        ElementKind::Hex8 | ElementKind::Hex20 | ElementKind::Truss2 => {
            for &(a, wa) in gl {
                for &(b, wb) in gl {
                    for &(c, wc) in gl {
                        points.push([a, b, c]);
                        weights.push(wa * wb * wc);
                    }
                }
            }
        }
        ElementKind::Quad4 | ElementKind::Quad8 => {
            for &(a, wa) in gl {
                for &(b, wb) in gl {
                    points.push([a, b, 0.0]);
                    weights.push(wa * wb);
                }
            }
        }
        ElementKind::Tri3 | ElementKind::Tri6 => {
            points.extend_from_slice(TRI_25.points);
            weights.extend_from_slice(TRI_25.weights);
        }
        ElementKind::Tet4 | ElementKind::Tet10 => {
            points.extend_from_slice(TET_125.points);
            weights.extend_from_slice(TET_125.weights);
        }
    }
    (points, weights)
}

/// The adjugate inverse and determinant of a 3 × 3 matrix.
fn invert3(m: &[[f64; 3]; 3]) -> ([[f64; 3]; 3], f64) {
    let c = |i: usize, j: usize| {
        let (i1, i2) = ((i + 1) % 3, (i + 2) % 3);
        let (j1, j2) = ((j + 1) % 3, (j + 2) % 3);
        m[j1][i1] * m[j2][i2] - m[j1][i2] * m[j2][i1]
    };
    let det = m[0][0] * c(0, 0) + m[0][1] * c(1, 0) + m[0][2] * c(2, 0);
    let mut inv = [[0.0; 3]; 3];
    for (i, row) in inv.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = c(i, j) / det;
        }
    }
    (inv, det)
}

/// Position, `w · det J`, shape values and physical shape gradients at the reference point
/// `xi` of one element (a 2D Jacobian is padded with `∂z/∂ζ = 1`).
fn kinematics_at(kind: ElementKind, coords: &[f64], xi: [f64; 3], w: f64) -> ([f64; 3], f64, Vec<f64>, Vec<[f64; 3]>) {
    let (nn, dim) = (kind.n_nodes(), kind.dim());
    let mut sh = vec![0.0; nn];
    let mut dn = vec![[0.0; 3]; nn];
    shape_of(kind, xi, &mut sh);
    dshape_of(kind, xi, &mut dn);
    let mut x = [0.0; 3];
    let mut j = [[0.0; 3]; 3];
    for a in 0..nn {
        for i in 0..3 {
            x[i] += sh[a] * coords[3 * a + i];
            for k in 0..dim {
                j[k][i] += dn[a][k] * coords[3 * a + i];
            }
        }
    }
    if dim == 2 {
        j[2][2] = 1.0;
    }
    let (inv, det) = invert3(&j);
    let g = dn.iter().map(|d| [0, 1, 2].map(|i| (0..dim).map(|k| d[k] * inv[i][k]).sum())).collect();
    (x, w * det, sh, g)
}

/// `(‖u_h − u‖_L2, |u_h − u|_H1)` of a nodal solution against the manufactured field: the
/// temperature and its gradient when `heat`, else the displacement and its engineering
/// strain, integrated with [`error_rule`].
fn manufactured_errors(mesh: &Mesh, u: &[f64], h: Harmonic, heat: bool) -> (f64, f64) {
    let dpn = u.len() / mesh.n_nodes();
    let (mut l2, mut h1) = (0.0, 0.0);
    let mut coords = Vec::new();
    for elem in 0..mesh.n_elems() as u32 {
        let kind = mesh.kind_of(elem);
        coords.resize(kind.n_nodes() * 3, 0.0);
        mesh.elem_coords(elem, &mut coords);
        let (points, weights) = error_rule(kind);
        for (&xi, &w) in points.iter().zip(&weights) {
            let (x, wd, sh, g) = kinematics_at(kind, &coords, xi, w);
            let mut val = vec![0.0; dpn];
            let mut du = [[0.0; 3]; 3];
            for (a, &n) in mesh.elem_nodes(elem).iter().enumerate() {
                for c in 0..dpn {
                    let ua = u[n as usize * dpn + c];
                    val[c] += sh[a] * ua;
                    for k in 0..3 {
                        du[c][k] += g[a][k] * ua;
                    }
                }
            }
            let (exact_val, exact_grad, grad): (Vec<f64>, Vec<f64>, Vec<f64>) = if heat {
                let (phi, gr, _) = harmonic(h, x);
                (vec![phi], gr.to_vec(), du[0].to_vec())
            } else {
                let (ue, ee) = exact_u(h, x);
                let mut e =
                    [du[0][0], du[1][1], du[2][2], du[0][1] + du[1][0], du[0][2] + du[2][0], du[1][2] + du[2][1]];
                if h == Harmonic::Axi {
                    e[2] = val[0] / x[0];
                }
                (ue[..dpn].to_vec(), ee.to_vec(), e.to_vec())
            };
            l2 += wd * val.iter().zip(&exact_val).map(|(a, b)| (a - b) * (a - b)).sum::<f64>();
            h1 += wd * grad.iter().zip(&exact_grad).map(|(a, b)| (a - b) * (a - b)).sum::<f64>();
        }
    }
    (l2.sqrt(), h1.sqrt())
}

/// The manufactured problem on one mesh — the exact field on every boundary DOF, no load —
/// solved and measured: `(L2 error, H1 error)`.
fn manufactured_solve(mesh: &Mesh, id: &Idealisation, form: Formulation, heat: bool) -> (f64, f64) {
    let sets = sets_of(mesh);
    let bodies = one_body();
    let h = harmonic_of(id);
    let dpn = if heat { 1 } else { mesh.dim };
    let exact: Vec<f64> = (0..mesh.n_nodes() as u32)
        .flat_map(|n| {
            let x = mesh.node(n);
            if heat {
                vec![harmonic(h, x).0]
            } else {
                exact_u(h, x).0[..dpn].to_vec()
            }
        })
        .collect();
    let k = if heat {
        let p = heat_problem(mesh, &sets, &bodies, id.clone(), steel(), Vec::new(), Vec::new());
        heat::assemble(&p, &pattern(mesh, 1), &Mpc::none()).expect("conductivity assembles").k
    } else {
        let p = problem(mesh, &sets, &bodies, id.clone(), form, Vec::new());
        assemble_stiffness(&p, &pattern(mesh, mesh.dim)).expect("stiffness assembles").k
    };
    let rc = boundary_constraints(mesh, &exact);
    let red = reduce(&k, &vec![0.0; k.n], &rc, &[]);
    let (u_f, _) =
        pollster::block_on(solve(&red.k_ff, &red.f_f, &SolveOptions::default(), &Pool::new(2), None, &mut nop))
            .expect("the manufactured system is positive definite");
    manufactured_errors(mesh, &expand(&red, &u_f), h, heat)
}

/// The observed L2 and H1 rates over the two finest of a series `(h, L2, H1)`, gated at
/// `p + 1` and `p` within 0.1 for an element of degree `p`.
fn assert_rates(series: &[(f64, f64, f64)], p: f64, label: &str) {
    let hs: Vec<f64> = series.iter().map(|s| s.0).collect();
    let l2: Vec<f64> = series.iter().map(|s| s.1).collect();
    let h1: Vec<f64> = series.iter().map(|s| s.2).collect();
    let n = series.len();
    let (rl2, rh1) = (observed_rate(&hs[n - 2..], &l2[n - 2..]), observed_rate(&hs[n - 2..], &h1[n - 2..]));
    eprintln!("D4 {label}: h {hs:?} L2 {l2:?} H1 {h1:?} → rates L2 {rl2:.3} (want {}) H1 {rh1:.3} (want {p})", p + 1.0);
    assert!((rl2 - (p + 1.0)).abs() <= 0.1, "{label}: L2 rate {rl2:.3}, expected {}", p + 1.0);
    assert!((rh1 - p).abs() <= 0.1, "{label}: H1 rate {rh1:.3}, expected {p}");
}

fn degree(kind: ElementKind) -> f64 {
    if kind.n_nodes() > kind.n_corners() {
        2.0
    } else {
        1.0
    }
}

/// D4: manufactured-solution refinement rates. For every element kind on the lattice mesher
/// (Kuhn-split for the simplex kinds) in every idealisation, and for both triangle orders on
/// the free mesher, the L2 error of the field converges at `p + 1` and the H1 error at `p`
/// within 0.1 — elasticity with `u = ∇φ` and conduction with `T = φ` for a harmonic `φ`.
///
/// A rate that is right with a wrong constant is caught by the answer benchmarks; a rate that
/// is wrong means an element is not what it claims to be: a quadrature rule too weak for its
/// degree, a shape function of the wrong order, a mid-node placed off the edge, a strain
/// term missing from `B` that a constant-strain patch test cannot see.
#[test]
fn manufactured_solutions_converge_at_p_plus_one_in_l2_and_p_in_h1() {
    for kind in ALL_KINDS {
        let p = degree(kind);
        let forms = if kind == ElementKind::Hex8 || kind == ElementKind::Quad4 {
            vec![Formulation::Full, Formulation::IncompatibleModes]
        } else {
            vec![Formulation::Full]
        };
        let meshes: Vec<(f64, Mesh)> =
            [2usize, 4, 8].iter().map(|&n| (1.0 / n as f64, lattice_block(kind, n))).collect();
        for id in idealisations(kind) {
            for &form in &forms {
                let series: Vec<(f64, f64, f64)> = meshes
                    .iter()
                    .map(|(h, m)| {
                        let (l2, h1) = manufactured_solve(m, &id, form, false);
                        (*h, l2, h1)
                    })
                    .collect();
                assert_rates(&series, p, &format!("{kind:?} {id:?} {form:?}"));
            }
            let series: Vec<(f64, f64, f64)> = meshes
                .iter()
                .map(|(h, m)| {
                    let (l2, h1) = manufactured_solve(m, &id, Formulation::Full, true);
                    (*h, l2, h1)
                })
                .collect();
            assert_rates(&series, p, &format!("{kind:?} {id:?} heat"));
        }
    }
    for quadratic in [false, true] {
        let p = if quadratic { 2.0 } else { 1.0 };
        // the unit square has area 1, so √(1 / n_elems) is the mean element size
        let meshes: Vec<(f64, Mesh)> = [0.25, 0.125, 0.0625]
            .iter()
            .map(|&size| {
                let m = free_square(quadratic, size);
                ((1.0 / m.n_elems() as f64).sqrt(), m)
            })
            .collect();
        for heat in [false, true] {
            let series: Vec<(f64, f64, f64)> = meshes
                .iter()
                .map(|(h, m)| {
                    let (l2, h1) = manufactured_solve(m, &Idealisation::PlaneStrain, Formulation::Full, heat);
                    (*h, l2, h1)
                })
                .collect();
            assert_rates(&series, p, &format!("free quadratic={quadratic} heat={heat}"));
        }
    }
}
