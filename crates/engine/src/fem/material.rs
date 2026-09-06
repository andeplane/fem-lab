//! Material Extension Point: a law maps strain (and state) at a batch of Gauss points to
//! stress and tangent. Flat `f64` slices only, so a TS/WGSL/wasm plugin can implement the
//! same trait; `LinearElastic` is the built-in that goes through the identical path.

use crate::error::{Error, ErrorCode};

/// Voigt order 11, 22, 33, 12, 13, 23; engineering shear strain (γ = 2ε₁₂). SI.
pub const VOIGT: usize = 6;

/// Inputs for one call: `n` Gauss points of one material.
pub struct MaterialBatch<'a> {
    pub n: usize,
    /// `n*6` total mechanical strain (thermal already removed).
    pub strain: &'a [f64],
    /// `n*6` increment since the last converged state (zeros for linear static).
    pub dstrain: &'a [f64],
    /// `n` current temperature, for T-dependent laws later.
    pub temperature: &'a [f64],
    pub dt: f64,
    /// `law.n_props()` values, one material per batch.
    pub props: &'a [f64],
    /// `n*law.n_state()`.
    pub state_in: &'a [f64],
}

/// Outputs for one call.
pub struct MaterialOut<'a> {
    /// `n*6`.
    pub stress: &'a mut [f64],
    /// `n*36` row-major dσ/dε.
    pub tangent: &'a mut [f64],
    /// `n*law.n_state()`.
    pub state_out: &'a mut [f64],
}

/// A constitutive law. No generic methods: the trait is dyn-compatible so built-ins and
/// plugins are both `&dyn MaterialLaw`.
pub trait MaterialLaw: Send + Sync {
    fn id(&self) -> &str;
    fn n_props(&self) -> usize;
    fn n_state(&self) -> usize;
    /// For the manifest / doc string; `len() == n_props()`.
    fn prop_names(&self) -> &[&str];
    fn evaluate(&self, b: MaterialBatch<'_>, out: MaterialOut<'_>) -> Result<(), Error>;
}

fn check_len(name: &str, got: usize, want: usize) -> Result<(), Error> {
    if got == want {
        Ok(())
    } else {
        Err(Error::new(ErrorCode::MaterialProps, format!("{name}: expected {want} values, got {got}"))
            .at(format!("material.{name}")))
    }
}

/// Every slice length a law relies on, checked once so `evaluate` can index freely.
pub fn check_batch(law: &dyn MaterialLaw, b: &MaterialBatch<'_>, out: &MaterialOut<'_>) -> Result<(), Error> {
    let (n, s) = (b.n, b.n * law.n_state());
    check_len("props", b.props.len(), law.n_props())?;
    check_len("strain", b.strain.len(), n * VOIGT)?;
    check_len("dstrain", b.dstrain.len(), n * VOIGT)?;
    check_len("temperature", b.temperature.len(), n)?;
    check_len("state_in", b.state_in.len(), s)?;
    check_len("stress", out.stress.len(), n * VOIGT)?;
    check_len("tangent", out.tangent.len(), n * VOIGT * VOIGT)?;
    check_len("state_out", out.state_out.len(), s)
}

/// Isotropic 3D elasticity: `λ = Eν/((1+ν)(1−2ν))`, `μ = E/(2(1+ν))`, `D = λ 1⊗1 + 2μ I_sym`
/// with shear rows `μ` (engineering shear).
pub fn isotropic_d(e: f64, nu: f64) -> [[f64; VOIGT]; VOIGT] {
    let lambda = e * nu / ((1.0 + nu) * (1.0 - 2.0 * nu));
    let mu = e / (2.0 * (1.0 + nu));
    let mut d = [[0.0; VOIGT]; VOIGT];
    for i in 0..3 {
        d[i][..3].fill(lambda);
        d[i][i] = lambda + 2.0 * mu;
        d[i + 3][i + 3] = mu;
    }
    d
}

/// Hooke's law; `props = [E, nu]`, no state.
pub struct LinearElastic;

impl MaterialLaw for LinearElastic {
    fn id(&self) -> &str {
        "linear-elastic"
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
            let eps = &b.strain[p * VOIGT..(p + 1) * VOIGT];
            let sig = &mut out.stress[p * VOIGT..(p + 1) * VOIGT];
            let tan = &mut out.tangent[p * VOIGT * VOIGT..(p + 1) * VOIGT * VOIGT];
            for i in 0..VOIGT {
                sig[i] = (0..VOIGT).map(|j| d[i][j] * eps[j]).sum();
                tan[i * VOIGT..(i + 1) * VOIGT].copy_from_slice(&d[i]);
            }
        }
        Ok(())
    }
}

static LINEAR_ELASTIC: LinearElastic = LinearElastic;

/// The built-in law with this id, if any.
pub fn builtin_law(id: &str) -> Option<&'static dyn MaterialLaw> {
    match id {
        "linear-elastic" => Some(&LINEAR_ELASTIC),
        _ => None,
    }
}

/// Voigt rows kept in plane stress: 11, 22, 12.
const PLANE: [usize; 3] = [0, 1, 3];
/// Newton iterations on ε₃₃ after the first evaluation; a linear law needs one.
const PLANE_STRESS_ITERS: usize = 3;

/// Plane stress through a 3D law: find ε₃₃ so that σ₃₃ = 0 (Newton on the whole batch,
/// `ε₃₃ -= σ₃₃ / C₃₃`, at most 3 iterations) and condense the tangent to 3×3,
/// `C_ps = C_pp − C_pz C_zz⁻¹ C_zp`. `strain_2d` is `n*3` (ε₁₁, ε₂₂, γ₁₂), `out_stress`
/// `n*3`, `out_tangent` `n*9` row-major. Stateless use: `state_in` is zeros and the updated
/// state is dropped.
pub fn plane_stress_condense(
    law: &dyn MaterialLaw,
    props: &[f64],
    strain_2d: &[f64],
    out_stress: &mut [f64],
    out_tangent: &mut [f64],
) -> Result<(), Error> {
    let n = strain_2d.len() / 3;
    check_len("strain", strain_2d.len(), n * 3)?;
    check_len("stress", out_stress.len(), n * 3)?;
    check_len("tangent", out_tangent.len(), n * 9)?;
    let mut eps = vec![0.0; n * VOIGT];
    for p in 0..n {
        for (k, &row) in PLANE.iter().enumerate() {
            eps[p * VOIGT + row] = strain_2d[p * 3 + k];
        }
    }
    let zeros = vec![0.0; n * VOIGT];
    let state_in = vec![0.0; n * law.n_state()];
    let mut state_out = vec![0.0; n * law.n_state()];
    let mut sig = vec![0.0; n * VOIGT];
    let mut tan = vec![0.0; n * VOIGT * VOIGT];
    let run = |eps: &[f64], sig: &mut [f64], tan: &mut [f64], state_out: &mut [f64]| {
        let b = MaterialBatch {
            n,
            strain: eps,
            dstrain: &zeros,
            temperature: &zeros[..n],
            dt: 0.0,
            props,
            state_in: &state_in,
        };
        law.evaluate(b, MaterialOut { stress: sig, tangent: tan, state_out })
    };
    run(&eps, &mut sig, &mut tan, &mut state_out)?;
    for _ in 0..PLANE_STRESS_ITERS {
        let converged = (0..n).all(|p| {
            let s = &sig[p * VOIGT..(p + 1) * VOIGT];
            s[2].abs() <= 1e-12 * s.iter().fold(0.0, |m: f64, v| m.max(v.abs()))
        });
        if converged {
            break;
        }
        for p in 0..n {
            eps[p * VOIGT + 2] -= sig[p * VOIGT + 2] / tan[p * VOIGT * VOIGT + 2 * VOIGT + 2];
        }
        run(&eps, &mut sig, &mut tan, &mut state_out)?;
    }
    for p in 0..n {
        let c = |i: usize, j: usize| tan[p * VOIGT * VOIGT + i * VOIGT + j];
        for (a, &i) in PLANE.iter().enumerate() {
            out_stress[p * 3 + a] = sig[p * VOIGT + i];
            for (b, &j) in PLANE.iter().enumerate() {
                out_tangent[p * 9 + a * 3 + b] = c(i, j) - c(i, 2) * c(2, j) / c(2, 2);
            }
        }
    }
    Ok(())
}
