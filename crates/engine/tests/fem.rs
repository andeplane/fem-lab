//! Quadrature rules against exact monomial integrals, and the Material Extension Point against
//! closed-form elasticity. One binary: llvm-cov does not merge instantiations across binaries.

use std::sync::atomic::{AtomicUsize, Ordering};

use femlab_engine::fem::material::{
    builtin_law, check_batch, isotropic_d, plane_stress_condense, LinearElastic, MaterialBatch, MaterialLaw,
    MaterialOut, VOIGT,
};
use femlab_engine::fem::quadrature::{
    gauss_legendre, Rule, HEX_2X2X2, HEX_3X3X3, QUAD_2X2, QUAD_3X3, TET_1, TET_4, TRI_1, TRI_3,
};
use femlab_engine::{Error, ErrorCode};

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
