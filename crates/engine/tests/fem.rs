//! Quadrature rules against exact monomial integrals, the Material Extension Point against
//! closed-form elasticity, the reference elements against their defining properties, and the
//! isoparametric solid against rigid modes, patch tests, closed-form totals and beam theory.
//! One binary: llvm-cov does not merge instantiations across binaries.

use std::sync::atomic::{AtomicUsize, Ordering};

use femlab_engine::command::Formulation;
use femlab_engine::fem::element::{element_for, Element, ElementCtx, FaceLoad, Iso, Material};
use femlab_engine::fem::material::{
    builtin_law, check_batch, isotropic_d, plane_stress_condense, LinearElastic, MaterialBatch, MaterialLaw,
    MaterialOut, VOIGT,
};
use femlab_engine::fem::quadrature::{
    gauss_legendre, Rule, HEX_2X2X2, HEX_3X3X3, QUAD_2X2, QUAD_3X3, TET_1, TET_4, TRI_1, TRI_3,
};
use femlab_engine::fem::shape::{
    centre_xi, dshape_of, face_dshape_of, face_rule_of, face_shape_of, in_reference, node_xi, rule_of, shape_of, Hex20,
    Hex8, Line2, Line3, Quad4, Quad4F, Quad8, Quad8F, RefElement, RefFace, Tet10, Tet4, Tri3, Tri3F, Tri6, Tri6F,
    LINE_2, LINE_3,
};
use femlab_engine::model::Idealisation;
use femlab_engine::{Error, ErrorCode};
use femlab_geometry::mesh::{ElementKind, FaceKind};

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

/// `u = ε · x` for one constant-strain mode (engineering shear halved).
fn patch_displacement(kind: ElementKind, id: &Idealisation, coords: &[f64], e: &[f64; VOIGT]) -> Vec<f64> {
    let axi = matches!(id, Idealisation::Axisymmetric);
    let three = kind.dim() == 3;
    nodal_field(kind, coords, &|x: [f64; 3]| {
        if three {
            [
                e[0] * x[0] + 0.5 * e[3] * x[1] + 0.5 * e[4] * x[2],
                0.5 * e[3] * x[0] + e[1] * x[1] + 0.5 * e[5] * x[2],
                0.5 * e[4] * x[0] + 0.5 * e[5] * x[1] + e[2] * x[2],
            ]
        } else if axi {
            [e[0] * x[0], e[1] * x[1] + e[3] * x[0], 0.0]
        } else {
            [e[0] * x[0] + 0.5 * e[3] * x[1], 0.5 * e[3] * x[0] + e[1] * x[1], 0.0]
        }
    })
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
