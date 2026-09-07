//! Material Extension Point: a law maps strain (and state) at a batch of Gauss points to
//! stress and tangent. Flat `f64` slices only, so a TS/WGSL/wasm plugin can implement the
//! same trait; `LinearElastic`, `OrthotropicElastic` and `J2Plasticity` are the built-ins that
//! go through the identical path — the last one is the history-dependent law the state slot
//! exists for.

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
    /// The name of every per-point state slot, `len() == n_state()`; Abaqus's `*DEPVAR` names.
    /// A procedure that reports a state as a Result field finds it here by name.
    fn state_names(&self) -> &[&str] {
        &[]
    }
    /// Whether `props` is a property vector this law accepts. Exactly `n_props()` values unless
    /// a law says otherwise — a law with a table of variable length (as a UMAT is handed
    /// `NPROPS`) checks its own count and its own admissibility here.
    fn check_props(&self, props: &[f64]) -> Result<(), Error> {
        check_len("props", props.len(), self.n_props())
    }
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
    law.check_props(b.props)?;
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
        "orthotropic-elastic" => Some(&ORTHOTROPIC_ELASTIC),
        "j2-plasticity" => Some(&J2_PLASTICITY),
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

/// Voigt row `i` as the tensor index pair `(a, b)`: 11, 22, 33, 12, 13, 23.
const PAIRS: [(usize, usize); VOIGT] = [(0, 0), (1, 1), (2, 2), (0, 1), (0, 2), (1, 2)];

/// The Voigt strain transform of a rotation whose **rows are the material axes in global
/// coordinates**: `T` with `ε_mat = T ε_glob`.
///
/// Because the energy `σ·ε` is the same in both frames when the shear entries are engineering
/// shear, the companion identities are `σ_glob = Tᵀ σ_mat` and `D_glob = Tᵀ D_mat T`. Strain
/// itself rotates the other way, and `T⁻¹ = voigt_rotation(Rᵀ)` — *not* `Tᵀ`, which is the
/// classical trap: with `γ = 2ε` the strain and stress transforms differ by factors of two.
///
/// Built one column at a time by rotating the tensor of each global unit engineering strain and
/// reading the result back as engineering strain, so those factors of two are never written by
/// hand.
pub fn voigt_rotation(r: &[[f64; 3]; 3]) -> [[f64; VOIGT]; VOIGT] {
    let mut t = [[0.0; VOIGT]; VOIGT];
    for (col, &(a, b)) in PAIRS.iter().enumerate() {
        let mut e = [[0.0; 3]; 3];
        e[a][b] = if a == b { 1.0 } else { 0.5 };
        e[b][a] = e[a][b];
        for (row, &(i, j)) in PAIRS.iter().enumerate() {
            let m: f64 = (0..3).map(|p| (0..3).map(|q| r[i][p] * e[p][q] * r[j][q]).sum::<f64>()).sum();
            t[row][col] = if i == j { m } else { 2.0 * m };
        }
    }
    t
}

/// The rotation whose **rows are the material axes in global coordinates**, from a unit `axis`
/// and an `angle` in radians (Rodrigues). Material axis 1 is the first row, so a lamina at +30°
/// about z has its fibre direction at +30° from global x.
pub fn axis_angle_rotation(axis: [f64; 3], angle: f64) -> [[f64; 3]; 3] {
    let (s, c) = (libm::sin(angle), libm::cos(angle));
    // Rodrigues gives `Q`, which carries a global direction to the rotated one, so the material
    // axes are `Q`'s columns and the matrix whose rows they are is `Qᵀ`.
    let mut r = [[0.0; 3]; 3];
    for (i, row) in r.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            // The `j`-th column of the cross-product matrix `[axis]ₓ`, row `i`.
            let cross = [
                axis[1] * f64::from(j == 2) - axis[2] * f64::from(j == 1),
                axis[2] * f64::from(j == 0) - axis[0] * f64::from(j == 2),
                axis[0] * f64::from(j == 1) - axis[1] * f64::from(j == 0),
            ];
            *v = c * f64::from(i == j) + s * cross[i] + (1.0 - c) * axis[i] * axis[j];
        }
    }
    transpose3(&r)
}

/// `Mᵀ`.
pub fn transpose3(m: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut t = [[0.0; 3]; 3];
    for (i, row) in t.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = m[j][i];
        }
    }
    t
}

/// `Rᵀ diag(d) R`: a tensor that is diagonal in the material axes, written in global
/// coordinates. The conductivity is a plain second-order tensor, so it rotates with no Voigt
/// bookkeeping at all.
pub fn rotate_diagonal(r: &[[f64; 3]; 3], d: [f64; 3]) -> [[f64; 3]; 3] {
    let mut out = [[0.0; 3]; 3];
    for (i, row) in out.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = (0..3).map(|k| r[k][i] * d[k] * r[k][j]).sum();
        }
    }
    out
}

/// How far the third material axis may drift from the out-of-plane direction and still count as
/// planar. The rotations that qualify produce exact zeros, so this only forgives a user's axis
/// that is a rounding error away from `[0, 0, 1]`.
const PLANAR_TOL: f64 = 1e-12;

/// Whether these material axes leave axis 3 along the global out-of-plane direction — the only
/// orientations a 2D idealisation can carry.
///
/// `D_glob = Tᵀ D_mat T` then keeps Voigt rows 13 and 23 decoupled from the rest, which is what
/// makes plane strain's "γ13 = γ23 = 0" and the axisymmetric hoop row true of the rotated
/// material as well as the unrotated one. Any other rotation would feed in-plane strain into
/// out-of-plane shear stress that the idealisation has nowhere to put.
pub fn axes_are_planar(r: &[[f64; 3]; 3]) -> bool {
    libm::fabs(r[2][0]) <= PLANAR_TOL && libm::fabs(r[2][1]) <= PLANAR_TOL
}

/// The nine props [`OrthotropicElastic`] takes, in order.
pub const ORTHOTROPIC_PROPS: [&str; 9] = ["E1", "E2", "E3", "G12", "G13", "G23", "nu12", "nu13", "nu23"];

/// The orthotropic compliance inverted into `D`, Voigt 11, 22, 33, 12, 13, 23 with engineering
/// shear, in the *material* axes. `props = [E1, E2, E3, G12, G13, G23, nu12, nu13, nu23]` in the
/// major Poisson convention `ν_ij/E_i = ν_ji/E_j`.
///
/// Admissibility is one test rather than a copied list of inequalities: the 3×3 normal
/// compliance block must be positive definite, which is exactly the statement that the strain
/// energy is positive, and a Cholesky factorisation of it is necessary and sufficient. It
/// subsumes `|ν12| < √(E1/E2)` and the determinant condition alike.
pub fn orthotropic_d(props: &[f64]) -> Result<[[f64; VOIGT]; VOIGT], Error> {
    check_len("props", props.len(), ORTHOTROPIC_PROPS.len())?;
    for (name, v) in ORTHOTROPIC_PROPS.iter().zip(props) {
        let ok = if name.starts_with("nu") { v.is_finite() } else { v.is_finite() && *v > 0.0 };
        if !ok {
            return Err(Error::new(
                ErrorCode::MaterialProps,
                format!("orthotropic {name} = {v}: moduli must be finite and positive, Poisson ratios finite"),
            )
            .at(format!("orthotropic.{name}"))
            .suggest("material.add with positive E1, E2, E3, G12, G13, G23"));
        }
    }
    let (e, g, nu) = (&props[..3], &props[3..6], &props[6..]);
    let s = [
        [1.0 / e[0], -nu[0] / e[0], -nu[1] / e[0]],
        [-nu[0] / e[0], 1.0 / e[1], -nu[2] / e[1]],
        [-nu[1] / e[0], -nu[2] / e[1], 1.0 / e[2]],
    ];
    let (l, pivot) = cholesky3(&s);
    let Some(l) = l else {
        return Err(Error::new(
            ErrorCode::MaterialProps,
            format!(
                "the orthotropic normal compliance is not positive definite: pivot {pivot} is not positive, so this \
                 combination of moduli and Poisson ratios would release energy under load"
            ),
        )
        .at("orthotropic")
        .suggest("material.add with |nu12| < sqrt(E1/E2), |nu13| < sqrt(E1/E3), |nu23| < sqrt(E2/E3)"));
    };
    let mut d = [[0.0; VOIGT]; VOIGT];
    for (i, col) in invert_from_cholesky(&l).iter().enumerate() {
        d[i][..3].copy_from_slice(col);
    }
    for (i, &gi) in g.iter().enumerate() {
        d[i + 3][i + 3] = gi;
    }
    Ok(d)
}

/// The lower Cholesky factor of a symmetric 3×3 and the index of the last pivot tried; the
/// factor is `None` at the first non-positive or nonfinite pivot, which is what makes this the
/// admissibility test itself.
fn cholesky3(a: &[[f64; 3]; 3]) -> (Option<[[f64; 3]; 3]>, usize) {
    let mut l = [[0.0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..=i {
            let sum = a[i][j] - (0..j).map(|k| l[i][k] * l[j][k]).sum::<f64>();
            if i != j {
                l[i][j] = sum / l[j][j];
            } else if sum.is_finite() && sum > 0.0 {
                l[i][i] = sum.sqrt();
            } else {
                return (None, i);
            }
        }
    }
    (Some(l), 2)
}

/// `A⁻¹` from `A = L Lᵀ`, by forward and back substitution on each unit vector. `A` is
/// symmetric, so the columns this fills are equally its rows.
fn invert_from_cholesky(l: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut inv = [[0.0; 3]; 3];
    for (c, col) in inv.iter_mut().enumerate() {
        let mut y = [0.0; 3];
        for i in 0..3 {
            y[i] = (f64::from(i == c) - (0..i).map(|k| l[i][k] * y[k]).sum::<f64>()) / l[i][i];
        }
        for i in (0..3).rev() {
            col[i] = (y[i] - (i + 1..3).map(|k| l[k][i] * col[k]).sum::<f64>()) / l[i][i];
        }
    }
    inv
}

/// Orthotropic elasticity in the material axes; `props = [E1, E2, E3, G12, G13, G23, nu12,
/// nu13, nu23]`, no state. Wrap it in [`Rotated`] to give those axes a direction in the model.
pub struct OrthotropicElastic;

impl MaterialLaw for OrthotropicElastic {
    fn id(&self) -> &str {
        "orthotropic-elastic"
    }
    fn n_props(&self) -> usize {
        ORTHOTROPIC_PROPS.len()
    }
    fn n_state(&self) -> usize {
        0
    }
    fn prop_names(&self) -> &[&str] {
        &ORTHOTROPIC_PROPS
    }
    fn evaluate(&self, b: MaterialBatch<'_>, out: MaterialOut<'_>) -> Result<(), Error> {
        check_batch(self, &b, &out)?;
        let d = orthotropic_d(b.props)?;
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

static ORTHOTROPIC_ELASTIC: OrthotropicElastic = OrthotropicElastic;

/// Any law evaluated in rotated material axes: strain in through `T`, stress and tangent back
/// out through `Tᵀ`. Non-generic on purpose — one instantiation, and it composes with
/// [`plane_stress_condense`], which takes `&dyn MaterialLaw`, and with every law added later.
pub struct Rotated<'a> {
    inner: &'a dyn MaterialLaw,
    t: [[f64; VOIGT]; VOIGT],
}

impl<'a> Rotated<'a> {
    /// `axes` rows are the material axes in global coordinates.
    pub fn new(inner: &'a dyn MaterialLaw, axes: &[[f64; 3]; 3]) -> Rotated<'a> {
        Rotated { inner, t: voigt_rotation(axes) }
    }
}

/// Every Voigt vector in `src` through `m`.
fn apply_voigt(m: &[[f64; VOIGT]; VOIGT], src: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0; src.len()];
    for (p, chunk) in out.chunks_mut(VOIGT).enumerate() {
        let v = &src[p * VOIGT..(p + 1) * VOIGT];
        for (i, o) in chunk.iter_mut().enumerate() {
            *o = (0..VOIGT).map(|j| m[i][j] * v[j]).sum();
        }
    }
    out
}

impl MaterialLaw for Rotated<'_> {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn n_props(&self) -> usize {
        self.inner.n_props()
    }
    fn n_state(&self) -> usize {
        self.inner.n_state()
    }
    fn prop_names(&self) -> &[&str] {
        self.inner.prop_names()
    }
    fn state_names(&self) -> &[&str] {
        self.inner.state_names()
    }
    fn check_props(&self, props: &[f64]) -> Result<(), Error> {
        self.inner.check_props(props)
    }
    fn evaluate(&self, b: MaterialBatch<'_>, out: MaterialOut<'_>) -> Result<(), Error> {
        check_batch(self, &b, &out)?;
        let (strain, dstrain) = (apply_voigt(&self.t, b.strain), apply_voigt(&self.t, b.dstrain));
        let n = b.n;
        let batch = MaterialBatch { strain: &strain, dstrain: &dstrain, ..b };
        let MaterialOut { stress, tangent, state_out } = out;
        self.inner.evaluate(
            batch,
            MaterialOut { stress: &mut stress[..], tangent: &mut tangent[..], state_out: &mut state_out[..] },
        )?;
        for p in 0..n {
            let sig = &mut stress[p * VOIGT..(p + 1) * VOIGT];
            let mat: [f64; VOIGT] = std::array::from_fn(|i| sig[i]);
            for (i, s) in sig.iter_mut().enumerate() {
                *s = (0..VOIGT).map(|k| self.t[k][i] * mat[k]).sum();
            }
            // `D_glob = Tᵀ (D_mat T)`, as two 6×6 products rather than one quadruple sum.
            let tan = &mut tangent[p * VOIGT * VOIGT..(p + 1) * VOIGT * VOIGT];
            let dt: [[f64; VOIGT]; VOIGT] = std::array::from_fn(|k| {
                std::array::from_fn(|j| (0..VOIGT).map(|l| tan[k * VOIGT + l] * self.t[l][j]).sum())
            });
            for i in 0..VOIGT {
                for j in 0..VOIGT {
                    tan[i * VOIGT + j] = (0..VOIGT).map(|k| self.t[k][i] * dt[k][j]).sum();
                }
            }
        }
        Ok(())
    }
}

// ------------------------------------------------------------------ J2 plasticity

/// The props [`J2Plasticity`] takes, in order: the elastic pair, the slope the yield curve keeps
/// beyond its last point, the number of points on the curve, and then the curve itself as
/// `(plasticStrain, stress)` pairs — the first pair is repeated here because every curve has at
/// least one, at zero plastic strain, whose stress is the initial yield. A table of `n` points is
/// `4 + 2n` values ([`MaterialLaw::check_props`]); linear hardening is one point and `H`.
pub const J2_PROPS: [&str; 6] = ["E", "nu", "H", "n", "plasticStrain0", "stress0"];

/// The per-point state of [`J2Plasticity`]: the plastic strain tensor in Voigt order with
/// engineering shear, so that `ε_e = ε − ε_p` component by component, then the equivalent
/// plastic strain (Abaqus's PEEQ), which is what the hardening curve is a function of.
pub const J2_STATE: [&str; 7] = [
    "plasticStrain11",
    "plasticStrain22",
    "plasticStrain33",
    "plasticStrain12",
    "plasticStrain13",
    "plasticStrain23",
    PEEQ,
];

/// The name of the equivalent-plastic-strain state slot. A procedure that reports a
/// `plasticStrain` field reads whichever slot a law calls this, so a plugin law with a slot of
/// this name reaches the same Result field as the built-in.
pub const PEEQ: &str = "peeq";

/// Where the props of [`J2Plasticity`] start: `[E, nu, H, n]` then the pairs.
const J2_HEAD: usize = 4;

/// The yield stress `σ_y(ε̄ᵖ)` and its slope `dσ_y/dε̄ᵖ` at equivalent plastic strain `ebar`
/// from the piecewise-linear curve in `props`, which continues past its last point with slope
/// `H`. On a breakpoint the slope is the one of the segment *starting* there, so the multiplier
/// search below can stand exactly on a breakpoint and still read the segment it is about to
/// walk.
pub fn yield_curve(props: &[f64], ebar: f64) -> (f64, f64) {
    let n = props[3] as usize;
    let point = |k: usize| (props[J2_HEAD + 2 * k], props[J2_HEAD + 2 * k + 1]);
    for k in 0..n - 1 {
        let ((e0, s0), (e1, s1)) = (point(k), point(k + 1));
        if ebar < e1 {
            let slope = (s1 - s0) / (e1 - e0);
            return (s0 + slope * (ebar - e0), slope);
        }
    }
    let (e_last, s_last) = point(n - 1);
    (s_last + props[2] * (ebar - e_last), props[2])
}

/// The plastic multiplier `Δγ` (the increment of equivalent plastic strain) that returns a
/// trial von Mises stress `q_trial` to the yield surface from `ebar_n`: the root of
/// `g(Δγ) = q_trial − 3μ Δγ − σ_y(ebar_n + Δγ)`.
///
/// `g` is continuous, strictly decreasing and piecewise linear with the same breakpoints as the
/// hardening curve, so the root is found exactly rather than iteratively: walk the breakpoints
/// beyond `ebar_n` while `g` is still positive, then solve the one linear segment the sign
/// change is in. No tolerance, no iteration count, and the same answer at any thread count.
pub fn plastic_multiplier(props: &[f64], mu: f64, ebar_n: f64, q_trial: f64) -> f64 {
    let g = |d: f64| q_trial - 3.0 * mu * d - yield_curve(props, ebar_n + d).0;
    let n = props[3] as usize;
    let mut lo = 0.0;
    for k in 1..n {
        let e_k = props[J2_HEAD + 2 * k];
        if e_k <= ebar_n {
            continue;
        }
        if g(e_k - ebar_n) <= 0.0 {
            break;
        }
        lo = e_k - ebar_n;
    }
    let (_, h) = yield_curve(props, ebar_n + lo);
    lo + g(lo) / (3.0 * mu + h)
}

/// Von Mises plasticity with isotropic hardening, small strain, radial return, consistent
/// tangent (Simo & Hughes, *Computational Inelasticity*, Box 3.2 with a general hardening
/// curve). `props` are [`J2_PROPS`] and the state is [`J2_STATE`].
///
/// One call advances every point from `state_in` (the last converged state) to `state_out` at
/// the total strain it is given: the elastic trial `σ_tr = D (ε − ε_p)`, the yield check
/// `q_tr − σ_y(ε̄ᵖ) > 0`, the multiplier from [`plastic_multiplier`], the stress pulled back
/// radially in deviatoric space, the plastic strain pushed along the same direction, and the
/// algorithmic tangent — the exact derivative of that stress with respect to the strain that
/// produced it, which is what makes a Newton loop around this law converge quadratically. An
/// elastic point returns Hooke's tangent and copies its state through unchanged.
///
/// Small strain only: the additive split `ε = ε_e + ε_p` is what this law knows. Under the
/// total Lagrangian procedure it is evaluated on Green–Lagrange strain and answers with second
/// Piola–Kirchhoff stress, which is exact for large rotations and small strains and is not a
/// finite-strain plasticity model.
pub struct J2Plasticity;

impl MaterialLaw for J2Plasticity {
    fn id(&self) -> &str {
        "j2-plasticity"
    }
    fn n_props(&self) -> usize {
        J2_PROPS.len()
    }
    fn n_state(&self) -> usize {
        J2_STATE.len()
    }
    fn prop_names(&self) -> &[&str] {
        &J2_PROPS
    }
    fn state_names(&self) -> &[&str] {
        &J2_STATE
    }
    /// `4 + 2n` values with `n ≥ 1`, plastic strains ascending from zero, every stress finite
    /// and positive, `H` finite and not negative: what a well-posed return map needs and what
    /// `material.add` has already checked with units and located errors.
    fn check_props(&self, props: &[f64]) -> Result<(), Error> {
        let bad = |what: String| {
            Err(Error::new(ErrorCode::MaterialProps, format!("j2-plasticity props: {what}"))
                .at("material.props")
                .suggest("material.add with a plasticity block"))
        };
        if props.len() < J2_PROPS.len() {
            return check_len("props", props.len(), J2_PROPS.len());
        }
        let n = props[3];
        if !(n >= 1.0 && n.fract() == 0.0 && props.len() == J2_HEAD + 2 * n as usize) {
            return bad(format!("n = {n} points need {} values, got {}", J2_HEAD as f64 + 2.0 * n, props.len()));
        }
        if !(props[2].is_finite() && props[2] >= 0.0) {
            return bad(format!("H = {} must be finite and not negative", props[2]));
        }
        let mut last = -1.0;
        for k in 0..n as usize {
            let (e, s) = (props[J2_HEAD + 2 * k], props[J2_HEAD + 2 * k + 1]);
            if !(s.is_finite() && s > 0.0) {
                return bad(format!("stress{k} = {s} must be finite and positive"));
            }
            if !(e.is_finite() && e > last) || (k == 0 && e != 0.0) {
                return bad(format!("plasticStrain{k} = {e} must ascend from 0"));
            }
            last = e;
        }
        Ok(())
    }
    fn evaluate(&self, b: MaterialBatch<'_>, out: MaterialOut<'_>) -> Result<(), Error> {
        check_batch(self, &b, &out)?;
        let (e, nu) = (b.props[0], b.props[1]);
        let d = isotropic_d(e, nu);
        let mu = e / (2.0 * (1.0 + nu));
        let kappa = e / (3.0 * (1.0 - 2.0 * nu));
        let ns = J2_STATE.len();
        for p in 0..b.n {
            let eps = &b.strain[p * VOIGT..(p + 1) * VOIGT];
            let st = &b.state_in[p * ns..(p + 1) * ns];
            let sig = &mut out.stress[p * VOIGT..(p + 1) * VOIGT];
            let tan = &mut out.tangent[p * VOIGT * VOIGT..(p + 1) * VOIGT * VOIGT];
            let so = &mut out.state_out[p * ns..(p + 1) * ns];
            so.copy_from_slice(st);
            // The elastic trial: Hooke on the elastic part of the strain.
            let ee: [f64; VOIGT] = std::array::from_fn(|i| eps[i] - st[i]);
            for i in 0..VOIGT {
                sig[i] = (0..VOIGT).map(|j| d[i][j] * ee[j]).sum();
                tan[i * VOIGT..(i + 1) * VOIGT].copy_from_slice(&d[i]);
            }
            let mean = (sig[0] + sig[1] + sig[2]) / 3.0;
            let s = [sig[0] - mean, sig[1] - mean, sig[2] - mean, sig[3], sig[4], sig[5]];
            let norm =
                (s[0] * s[0] + s[1] * s[1] + s[2] * s[2] + 2.0 * (s[3] * s[3] + s[4] * s[4] + s[5] * s[5])).sqrt();
            let q = (1.5f64).sqrt() * norm;
            let ebar = st[6];
            if q <= yield_curve(b.props, ebar).0 {
                continue;
            }
            // Radial return: the deviatoric direction is fixed by the trial, the multiplier by
            // the scalar consistency condition along it.
            let dg = plastic_multiplier(b.props, mu, ebar, q);
            let nhat: [f64; VOIGT] = std::array::from_fn(|i| s[i] / norm);
            let dep = (1.5f64).sqrt() * dg;
            for i in 0..VOIGT {
                sig[i] -= 2.0 * mu * dep * nhat[i];
                // Engineering shear in the stored plastic strain: twice the tensor component.
                so[i] += if i < 3 { dep * nhat[i] } else { 2.0 * dep * nhat[i] };
            }
            so[6] = ebar + dg;
            // The algorithmic tangent, with the hardening slope at the *updated* state.
            let hp = yield_curve(b.props, so[6]).1;
            let theta = 1.0 - 3.0 * mu * dg / q;
            let theta_bar = 3.0 * mu / (3.0 * mu + hp) - 3.0 * mu * dg / q;
            for i in 0..VOIGT {
                for j in 0..VOIGT {
                    let volumetric = if i < 3 && j < 3 { kappa } else { 0.0 };
                    let dev = match (i < 3, j < 3) {
                        (true, true) => f64::from(i == j) - 1.0 / 3.0,
                        (false, false) => 0.5 * f64::from(i == j),
                        _ => 0.0,
                    };
                    tan[i * VOIGT + j] = volumetric + 2.0 * mu * theta * dev - 2.0 * mu * theta_bar * nhat[i] * nhat[j];
                }
            }
        }
        Ok(())
    }
}

static J2_PLASTICITY: J2Plasticity = J2Plasticity;
