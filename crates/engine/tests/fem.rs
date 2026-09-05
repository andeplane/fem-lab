//! Quadrature rules against exact monomial integrals, the Material Extension Point against
//! closed-form elasticity, the reference elements against their defining properties, and the
//! isoparametric solid against rigid modes, patch tests, closed-form totals and beam theory.
//! One binary: llvm-cov does not merge instantiations across binaries.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use femlab_engine::command::Formulation;
use femlab_engine::command::{Field, Solver};
use femlab_engine::fem::assembly::{
    assemble_stiffness, expand, pattern, reactions, reduce, resolve, Assembled, Csr, Pattern, ResolvedConstraints,
};
use femlab_engine::fem::checks;
use femlab_engine::fem::element::{element_for, Element, ElementCtx, FaceLoad, Iso, Material};
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
use femlab_engine::procedure::{self, Step, StepResult};
use femlab_engine::solve::{cost_estimate, resolve_solver, solve, solver_name, SolveOptions};
use femlab_engine::{Error, ErrorCode, ResolvedSet, SetKind};
use femlab_engine::{OnProgress, Progress};
use femlab_geometry::mesh::{ElementKind, FaceKind};
use femlab_geometry::{annulus, perturb_interior, Mesh, Structured};

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
fn only_the_direct_solver_and_the_static_procedure_exist_so_far() {
    let k = Csr { n: 1, row_ptr: vec![0, 1], col_idx: vec![0], vals: vec![2.0] };
    for solver in [Solver::CpuPcg, Solver::GpuPcg] {
        let opts = SolveOptions { solver, ..SolveOptions::default() };
        let e = pollster::block_on(solve(&k, &[1.0], &opts, &Pool::new(2), None, &mut nop)).expect_err("not built yet");
        assert_eq!(e.code, ErrorCode::Unsupported);
        assert!(e.cause.contains(&solver_name(solver)), "{}", e.cause);
    }
    assert_eq!(resolve_solver(Solver::Auto), Solver::CpuDirect);
    assert_eq!(resolve_solver(Solver::GpuPcg), Solver::GpuPcg);
    assert_eq!(solver_name(Solver::CpuDirect), "cpu-direct");

    let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
    let sets = sets_of(&mesh);
    let bodies = vec!["c".to_string()];
    let p = problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, Vec::new());
    for step in [Step::Modal, Step::HeatSteady, Step::HeatTransient, Step::Explicit] {
        let e = pollster::block_on(procedure::run(&p, &step, &Pool::new(2), None, None, &mut nop))
            .expect_err("only static so far");
        assert_eq!(e.code, ErrorCode::Unsupported);
        assert!(e.cause.contains(step.name()), "{}", e.cause);
    }
    assert_eq!(Step::Static { solver: SolveOptions::default() }.name(), "static");
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
