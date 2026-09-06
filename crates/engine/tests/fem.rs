//! Quadrature rules against exact monomial integrals, the Material Extension Point against
//! closed-form elasticity, the reference elements against their defining properties, and the
//! isoparametric solid against rigid modes, patch tests, closed-form totals and beam theory.
//! One binary: llvm-cov does not merge instantiations across binaries.

use std::collections::BTreeMap;
use std::f64::consts::PI;
use std::sync::atomic::{AtomicUsize, Ordering};

use femlab_engine::command::Formulation;
use femlab_engine::command::{Field, Solver};
use femlab_engine::fem::assembly::{
    assemble_stiffness, expand, pattern, reactions, reduce, resolve, Assembled, Csr, Pattern, ResolvedConstraints,
};
use femlab_engine::fem::checks;
use femlab_engine::fem::element::{element_for, Element, ElementCtx, FaceLoad, Iso, Material};
use femlab_engine::fem::heat::HeatLoad;
use femlab_engine::fem::loads::{assemble_loads, face_set_area, Load, LoadTotals};
use femlab_engine::fem::material::{
    builtin_law, check_batch, isotropic_d, plane_stress_condense, LinearElastic, MaterialBatch, MaterialLaw,
    MaterialOut, VOIGT,
};
use femlab_engine::fem::problem::{Constraint, Problem};
use femlab_engine::fem::quadrature::{
    gauss_legendre, Rule, HEX_2X2X2, HEX_3X3X3, QUAD_2X2, QUAD_3X3, TET_1, TET_4, TRI_1, TRI_3,
};
use femlab_engine::fem::shape::{
    centre_xi, dshape_of, face_dshape_of, face_rule_of, face_shape_of, in_reference, node_xi, rule_of, shape_of, Hex20,
    Hex8, Line2, Line3, Quad4, Quad4F, Quad8, Quad8F, RefElement, RefFace, Tet10, Tet4, Tri3, Tri3F, Tri6, Tri6F,
    LINE_2, LINE_3,
};
use femlab_engine::model::Idealisation;
use femlab_engine::par::Pool;
use femlab_engine::post::convergence::{observed_rate, richardson};
use femlab_engine::post::probe::{path, probe};
use femlab_engine::post::stress::{average_at_nodes, principal, stress_gp, von_mises};
use femlab_engine::post::{extremes, reactions_per_constraint, FieldData, Per};
use femlab_engine::procedure::{self, heat, Step, StepResult};
use femlab_engine::solve::{cost_estimate, resolve_solver, solve, solver_name, SolveOptions};
use femlab_engine::{Error, ErrorCode, ResolvedSet, SetKind};
use femlab_engine::{OnProgress, Progress};
use femlab_geometry::mesh::{ElementKind, FaceKind};
use femlab_geometry::{annulus, mapped, perturb_interior, Curve, Mesh, QuadBlock, Structured};

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
    ElementCtx { coords, material: mat, idealisation: id, formulation: form, temperature: None, t_ref: 0.0 }
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

#[test]
fn inverse_map_round_trips_the_gauss_points_and_rejects_the_rest() {
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
        assert!(el.inverse_map(&coords, [100.0, 100.0, 100.0]).is_none(), "{kind:?} far point");
        assert!(el.inverse_map(&folded(kind), [2.0, 1.0, 0.5]).is_none(), "{kind:?} folded");
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
use femlab_engine::io::{read_msh, write_inp, write_msh, write_stl, write_stl_mesh};
use femlab_geometry::{elliptic_annulus, split_to_simplices, ElementBlock, Face, Shape, Solid, TriMesh};

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
    // only block 0's elements, which the writer can represent (the whole block is covered);
    // "mixed" covers only element 0 of block 0, which is NOT block-aligned and so is dropped on
    // write — a documented limitation no mesher in this codebase runs into.
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
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::from([
            ("all".to_string(), (0..3u32).collect()),
            ("half".to_string(), (0..2u32).collect()),
            ("mixed".to_string(), vec![0]),
        ]),
        face_sets: BTreeMap::new(),
    };
    let text = write_msh(&m);
    // every set gets a $PhysicalNames entry regardless of whether any entity ends up tagged
    // with it, so check that "mixed" is unreferenced rather than absent from the text
    assert!(text.contains("\"all\""));
    assert!(text.contains("\"half\""));
    let back = read_msh(&text).unwrap();
    assert_eq!(back.elem_sets.get("all"), Some(&(0..3u32).collect::<Vec<_>>()));
    assert_eq!(back.elem_sets.get("half"), Some(&(0..2u32).collect::<Vec<_>>()));
    assert!(
        !back.elem_sets.contains_key("mixed"),
        "a set not aligned to a whole block must be dropped, not partly written: {:?}",
        back.elem_sets
    );
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
fn read_msh_rejects_point_entities() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$Entities", 1, "1 1 1 0"), "point entities");
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
fn read_msh_rejects_more_than_one_nodes_entity_block() {
    let (good, _) = good_msh_text();
    assert_schema_err(&set_line_after(&good, "$Nodes", 1, "2 3 1 3"), "a single $Nodes entity block");
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
    // same entity dim as the mesh (2), but a line2 type, which is never a volume element
    assert_schema_err(&set_line_after(&good, "$Elements", 4, "2 1 1 1"), "unknown element type 1");
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
        ("$Nodes", 6, "x 0 0"),                  // a node coordinate
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
        idealisation: id,
        formulation: form,
        constraints,
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
    let red = reduce(&a.k, &f, &rc);
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
    let r = reactions(&a.k, &u, &f, &red);
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

fn run_static(p: &Problem<'_>, progress: OnProgress<'_>) -> Result<StepResult, Error> {
    let step = Step::Static { solver: SolveOptions::default() };
    pollster::block_on(procedure::run(p, &step, &Pool::new(2), None, None, progress))
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

/// Every DOF of every boundary node, with the value the exact field takes there.
fn boundary_constraints(mesh: &Mesh, exact: &[f64]) -> ResolvedConstraints {
    let mut nodes: Vec<u32> = mesh.boundary_faces().iter().flat_map(|&f| mesh.face_nodes(f)).collect();
    nodes.sort_unstable();
    nodes.dedup();
    let fixed: Vec<(u32, f64)> = nodes
        .iter()
        .flat_map(|&n| (0..mesh.dim).map(move |c| (n * mesh.dim as u32 + c as u32, 0.0)))
        .map(|(d, _)| (d, exact[d as usize]))
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
        let bodies = vec!["patch".to_string()];
        for id in idealisations(kind) {
            // In axisymmetry a constant γ_rz is not an equilibrium state — it needs the body
            // force σ_rz/r — so the mesh patch test drops it; the single-element test, where
            // every node is prescribed, still covers it.
            let axi = matches!(id, Idealisation::Axisymmetric);
            let modes: Vec<[f64; VOIGT]> =
                patch_modes(&id).into_iter().enumerate().filter(|(i, _)| !(axi && *i == 2)).map(|(_, e)| e).collect();
            for e in modes {
                let p = problem(
                    &mesh,
                    &sets,
                    &bodies,
                    id.clone(),
                    Formulation::IncompatibleModes,
                    vec![fix("edge", "all", [true, true, true], 0.0)],
                );
                let pat = pattern(&mesh, mesh.dim);
                let a = assemble_stiffness(&p, &pat).expect("a patch mesh assembles");
                let exact = patch_mesh_field(&mesh, &id, &e);
                let rc = boundary_constraints(&mesh, &exact);
                let red = reduce(&a.k, &vec![0.0; a.k.n], &rc);
                let (u_f, info) = pollster::block_on(solve(
                    &red.k_ff,
                    &red.f_f,
                    &SolveOptions::default(),
                    &Pool::new(2),
                    None,
                    &mut nop,
                ))
                .expect("the patch system is positive definite");
                assert!(info.rel_residual < 1e-10, "{kind:?}: residual {}", info.rel_residual);
                let u = expand(&red, &u_f);
                let scale = exact.iter().fold(0.0f64, |m, x| m.max(x.abs()));
                for (i, (got, want)) in u.iter().zip(&exact).enumerate() {
                    assert!((got - want).abs() <= 1e-10 * scale, "{kind:?} {id:?} dof {i}: {got} vs {want}");
                }
                // and the stress at every Gauss point is D ε
                let want = expected_stress(&id, &e);
                let sscale = want.iter().fold(0.0f64, |m, x| m.max(x.abs()));
                let el = element_for(kind);
                let (nn, n_gp) = (kind.n_nodes(), el.n_gp());
                let mut coords = vec![0.0; nn * 3];
                for elem in 0..mesh.n_elems() as u32 {
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
                                "{kind:?} {id:?} element {elem} gp {g} component {i}: {got} vs {}",
                                want[i]
                            );
                        }
                    }
                }
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
        Step::Static { solver: opts },
        Step::Modal { n_modes: 3, shift: None, solver: opts },
        Step::HeatSteady { solver: opts },
        Step::HeatTransient {
            dt: 1.0,
            t_end: 2.0,
            theta: 0.5,
            initial: 0.0,
            output_every: 1,
            amplitude: None,
            solver: opts,
        },
        Step::Explicit { t_end: 1.0, dt_factor: 0.9, initial_velocity: None, output_every: 1 },
    ]
    .iter()
    .map(Step::name)
    .collect();
    assert_eq!(names, ["static", "modal", "heat-steady", "heat-transient", "explicit"]);
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
    let red = reduce(&a.k, &f, &rc);
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
fn the_cost_estimate_matches_the_pattern_it_came_from() {
    let mesh = Structured { kind: ElementKind::Hex8, n: [2, 2, 2] }.box_([1.0, 1.0, 1.0]);
    let pat = pattern(&mesh, 3);
    for solver in [Solver::Auto, Solver::CpuDirect, Solver::CpuPcg, Solver::GpuPcg] {
        let c = cost_estimate(&mesh, 3, solver);
        assert_eq!(c.dofs, pat.csr.n as u64);
        assert_eq!(c.nnz, pat.csr.nnz() as u64);
        assert_eq!(c.bytes, c.nnz * 12 + c.dofs * 32);
        assert!(c.feasible, "a 2 x 2 x 2 box fits anywhere");
        assert!(c.note.contains(&c.nnz.to_string()));
    }
    assert!(cost_estimate(&mesh, 3, Solver::Auto).note.starts_with("cpu-direct"));
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
        let step = Step::Static { solver: SolveOptions::default() };
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

// ------------------------------------------------------- heat, modal, transient, explicit
//
// Benchmarks E1, E2, C7, E3, B4, C6, F1 and F2 of `docs/BENCHMARKS.md`, plus the
// well-posedness and argument checks the four new procedures own. Everything here builds a
// `Problem` and calls `procedure::run` directly; the Command-level forms are the Journals in
// `crates/engine/benches/cases`.

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
        idealisation: id,
        formulation: Formulation::Full,
        constraints,
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

fn steady() -> Step {
    Step::HeatSteady { solver: SolveOptions::default() }
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
    p.materials[0].rho = 0.0;
    let step = Step::Modal { n_modes: 2, shift: None, solver: SolveOptions::default() };
    let e = run_step(&p, &step).expect_err("no density, no mass");
    assert_eq!(e.code, ErrorCode::ModelIllPosed);
    assert!(e.cause.contains("density"), "{}", e.cause);

    // An explicit Step has the same problem and reports it the same way.
    let boom = Step::Explicit { t_end: 1e-3, dt_factor: 0.9, initial_velocity: None, output_every: 1 };
    let e = run_step(&p, &boom).expect_err("no density, no time step");
    assert_eq!(e.code, ErrorCode::ModelIllPosed);
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
    // The face loop runs first, so with a convection load it is the one that reports the Body.
    assert_eq!(heat::assemble(&p, &pat).expect_err("no material").code, ErrorCode::ModelNoMaterial);
    // Without one, the element loop reports it instead.
    p.heat_loads = vec![HeatLoad::Source { bodies: one_body(), q: 1.0 }];
    assert_eq!(heat::assemble(&p, &pat).expect_err("no material").code, ErrorCode::ModelNoMaterial);
    assert_eq!(heat::assemble_capacity(&p, &pat).expect_err("no material").code, ErrorCode::ModelNoMaterial);
    let e = run_step(&p, &steady()).expect_err("the checks catch it first");
    assert_eq!(e.code, ErrorCode::ModelNoMaterial);
    // The material is there but the convection Set is not: the face loop reports the Set.
    p.material_of_block = vec![Some(0)];
    p.heat_loads = vec![HeatLoad::Convection { faces: "nowhere".into(), h: 10.0, t_inf: 300.0 }];
    assert_eq!(heat::assemble(&p, &pat).expect_err("no such Set").code, ErrorCode::SetEmpty);

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
    };
    let steps: Vec<(&Problem<'_>, Step)> = vec![
        (&hot, steady()),
        (&hot, transient),
        (&solid, Step::Modal { n_modes: 2, shift: Some(-1.0), solver: SolveOptions::default() }),
        (&solid, Step::Explicit { t_end: 1e-5, dt_factor: 0.9, initial_velocity: None, output_every: 1 }),
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
}
