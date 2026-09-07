//! The Element Extension Point and its one built-in: the isoparametric solid `Iso<R>`.
//!
//! An element turns node coordinates, a material and an idealisation into the element matrices
//! and vectors the assembler needs. The trait is dyn-compatible — flat `f64` slices, no generic
//! methods — so `element_for` hands out `&'static dyn Element` and a plugin written from the
//! doc strings alone goes through the same call path as `Iso`.
//!
//! `Iso<R>` itself is a thin typed shell: every method forwards to a free function that takes
//! the `ElementKind`, so the eight instantiations share one copy of the numerics.
//!
//! Conventions. Strain is Voigt 11, 22, 33, 12, 13, 23 with engineering shear; a 2D
//! idealisation fills the components it has and leaves the rest zero. Weights are
//! `w · det J · s` with `s` the thickness (plane stress), 1 (plane strain and 3D) or `2π r`
//! (axisymmetric, where `x` is `r` and `y` is `z`). Thermal strain `α (T − T_ref)` is
//! subtracted from the total strain before the law is called, and the law is called once per
//! element with every Gauss point in one batch.

use std::f64::consts::PI;
use std::marker::PhantomData;

use femlab_geometry::mesh::ElementKind;
use femlab_geometry::{Face, Mesh};

use crate::command::Formulation;
use crate::error::{Error, ErrorCode};
use crate::fem::material::{plane_stress_condense, MaterialBatch, MaterialLaw, MaterialOut, VOIGT};
use crate::fem::quadrature::Rule;
use crate::fem::section::Section;
use crate::fem::shape::{
    centre_xi, dshape_of, face_dshape_of, face_rule_of, face_shape_of, in_reference, product_rule_of, rule_of,
    shape_of, Hex20, Hex8, Quad4, Quad8, RefElement, Tet10, Tet4, Tri3, Tri6,
};
use crate::model::Idealisation;

/// A material resolved to numbers: the law and its props, plus the properties the *element*
/// owns (density, expansion, conductivity, specific heat), which no law ever sees.
/// `model::Material` is the serialisable row this is resolved from.
pub struct Material {
    pub law: &'static dyn MaterialLaw,
    pub props: Vec<f64>,
    pub rho: f64,
    pub alpha: f64,
    pub k: f64,
    pub cp: f64,
}

/// Everything one element integral needs besides the load itself.
pub struct ElementCtx<'a> {
    /// `n_nodes * 3`, stride 3 (`z = 0` in 2D).
    pub coords: &'a [f64],
    pub material: &'a Material,
    pub idealisation: Idealisation,
    pub formulation: Formulation,
    /// The cross-section of a line member; `None` for a solid, which has its own geometry.
    pub section: Option<&'a Section>,
    /// Nodal temperature; `None` → no thermal strain.
    pub temperature: Option<&'a [f64]>,
    pub t_ref: f64,
}

/// A distributed load on one element face: a pressure along `−n` or a traction vector.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FaceLoad {
    Pressure(f64),
    Traction([f64; 3]),
}

/// Outcome of isoparametric point location. `Outside` is a converged reference coordinate
/// outside the element; `Failed` means the map could not be inverted numerically.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InverseMap {
    Inside([f64; 3]),
    Outside,
    Failed,
}

/// One element formulation. Every matrix is row-major and every vector is node-major
/// (`dim * node + component`).
pub trait Element: Send + Sync {
    fn kind(&self) -> ElementKind;
    /// `n_nodes * dim`.
    fn n_dof(&self) -> usize;
    /// Stiffness/recovery points; mass integration may use a higher-degree rule.
    fn n_gp(&self) -> usize;
    /// `K_e`, row-major `n_dof × n_dof`; returns the smallest Gauss-point `det J`, which the
    /// well-posedness check reports.
    fn stiffness(&self, c: &ElementCtx<'_>, k: &mut [f64]) -> Result<f64, Error>;
    /// Consistent `∫ ρ Nᵀ N dV`, or its HRZ-scaled diagonal when `lumped`.
    fn mass(&self, c: &ElementCtx<'_>, m: &mut [f64], lumped: bool) -> Result<(), Error>;
    /// `∫ Nᵀ f dV` for a body force per unit volume evaluated at the Gauss points (gravity is `ρ g`).
    fn body_load(&self, c: &ElementCtx<'_>, f: &dyn Fn([f64; 3]) -> [f64; 3], out: &mut [f64]) -> Result<(), Error>;
    /// `∫ Bᵀ D ε_th dV`; all zeros when `c.temperature` is `None`.
    fn thermal_load(&self, c: &ElementCtx<'_>, out: &mut [f64]) -> Result<(), Error>;
    /// Consistent nodal load on one face (Abaqus S1.. identity, 0-based).
    fn face_load(&self, c: &ElementCtx<'_>, local_face: u8, load: FaceLoad, out: &mut [f64]) -> Result<(), Error>;
    /// Total strain and stress at the Gauss points, `VOIGT` each: `stress.len() == n_gp * 6`.
    fn recover(&self, c: &ElementCtx<'_>, u: &[f64], stress: &mut [f64], strain: &mut [f64]) -> Result<(), Error>;
    /// Parametric coordinates of Gauss point `i`, for extrapolation and probes.
    fn gp_xi(&self, i: usize) -> [f64; 3];
    fn shape_at(&self, xi: [f64; 3], n: &mut [f64]);
    /// Newton inversion of the isoparametric map.
    fn inverse_map(&self, coords: &[f64], x: [f64; 3]) -> Option<[f64; 3]>;
    /// Rich point-location status. Existing implementations that only provide `inverse_map`
    /// conservatively classify a missing reference point as a failure; implementations must
    /// override this method before they can report positive outside coverage.
    fn inverse_map_status(&self, coords: &[f64], x: [f64; 3]) -> InverseMap {
        self.inverse_map(coords, x).map_or(InverseMap::Failed, InverseMap::Inside)
    }
    /// `√λ_max` of `M_lumped⁻¹ K_e`: the element bound on the global `ω_max` for `Δt_crit`.
    fn omega_max(&self, c: &ElementCtx<'_>) -> Result<f64, Error>;
}

// ------------------------------------------------------------------ kernels

/// Voigt row, displacement component, derivative direction: the 3D `B` layout of §13.
const B_MAP: [(usize, usize, usize); 9] =
    [(0, 0, 0), (1, 1, 1), (2, 2, 2), (3, 0, 1), (3, 1, 0), (4, 0, 2), (4, 2, 0), (5, 1, 2), (5, 2, 1)];
/// Voigt rows a plane-stress law keeps: 11, 22, 12.
const PLANE: [usize; 3] = [0, 1, 3];
/// Dimensionless determinant tolerance after scaling the active Jacobian by its largest entry.
const DET_TOL: f64 = 1e-14;

/// The material's density, or the `model.ill-posed` error every mass integral reports.
pub(crate) fn density(c: &ElementCtx<'_>) -> Result<f64, Error> {
    if c.material.rho.is_finite() && c.material.rho >= 0.0 {
        Ok(c.material.rho)
    } else {
        Err(Error::new(ErrorCode::ModelIllPosed, "material density must be finite and non-negative")
            .at("material.rho")
            .suggest("material.add with rho >= \"0 kg/m^3\""))
    }
}

/// The `model.ill-posed` error a frequency bound reports for a weightless element.
pub(crate) fn no_density() -> Error {
    Error::new(ErrorCode::ModelIllPosed, "an element with zero density has no natural frequency")
        .at("material.rho")
        .suggest("material.add with rho, e.g. \"7850 kg/m^3\"")
}

pub(crate) fn inverted() -> Error {
    Error::new(ErrorCode::MeshInverted, "the element Jacobian is inverted, numerically singular or nonfinite")
        .at("element")
        .suggest("check the geometry and use mesh.set to regenerate the mesh")
}

/// The idealisation's weight factor at a point: thickness, 1, or `2π r`.
pub(crate) fn scale_at(id: &Idealisation, x: [f64; 3]) -> f64 {
    match id {
        Idealisation::Solid3d | Idealisation::PlaneStrain => 1.0,
        Idealisation::PlaneStress { thickness } => *thickness,
        Idealisation::Axisymmetric => 2.0 * PI * x[0],
    }
}

/// Internal incompatible-mode count: `dim²` for hex8 and quad4 under `IncompatibleModes`, and
/// zero otherwise — every other kind falls back to full integration.
fn n_modes(kind: ElementKind, f: Formulation) -> usize {
    match (f, kind) {
        (Formulation::IncompatibleModes, ElementKind::Hex8) => 9,
        (Formulation::IncompatibleModes, ElementKind::Quad4) => 4,
        _ => 0,
    }
}

fn det3(j: &[[f64; 3]; 3]) -> f64 {
    j[0][0] * (j[1][1] * j[2][2] - j[1][2] * j[2][1]) - j[0][1] * (j[1][0] * j[2][2] - j[1][2] * j[2][0])
        + j[0][2] * (j[1][0] * j[2][1] - j[1][1] * j[2][0])
}

/// `J⁻¹` and `det J` of `J_ij = Σ_a x_ai dN_a/dξ_j`, or `None` for an inverted, relatively
/// singular or nonfinite map. Normalising only the validity check makes it independent of
/// physical length units; the returned determinant and inverse retain their physical units.
/// In 2D the unused row and column are the identity, so the 3×3 formulas give the 2×2 answer.
pub(crate) fn jac_inv(dim: usize, coords: &[f64], dn: &[[f64; 3]]) -> Option<([[f64; 3]; 3], f64)> {
    let mut j = [[0.0f64; 3]; 3];
    for (a, d) in dn.iter().enumerate() {
        for (i, ji) in j.iter_mut().enumerate().take(dim) {
            for (k, jik) in ji.iter_mut().enumerate().take(dim) {
                *jik += coords[3 * a + i] * d[k];
            }
        }
    }
    for (i, ji) in j.iter_mut().enumerate().skip(dim) {
        ji[i] = 1.0;
    }
    // The padding identity in 2D must not set the length scale of a microscopic sheet.
    let scale = j.iter().take(dim).flat_map(|row| row.iter().take(dim)).fold(0.0f64, |s, x| s.max(x.abs()));
    let mut relative = j;
    for row in relative.iter_mut().take(dim) {
        for entry in row.iter_mut().take(dim) {
            *entry /= scale;
        }
    }
    let det = det3(&j);
    if !(det3(&relative) > DET_TOL && det > 0.0 && det.is_finite()) {
        return None;
    }
    // (J⁻¹)_ab = (J_{b+1,a+1} J_{b+2,a+2} − J_{b+1,a+2} J_{b+2,a+1}) / det, indices mod 3
    let mut inv = [[0.0f64; 3]; 3];
    for (a, row) in inv.iter_mut().enumerate() {
        for (b, v) in row.iter_mut().enumerate() {
            let (a1, a2) = ((a + 1) % 3, (a + 2) % 3);
            let (b1, b2) = ((b + 1) % 3, (b + 2) % 3);
            *v = (j[b1][a1] * j[b2][a2] - j[b1][a2] * j[b2][a1]) / det;
        }
    }
    Some((inv, det))
}

/// `∂N_a/∂x_i = Σ_j (dN_a/dξ_j)(J⁻¹)_ji`.
pub(crate) fn grad_of(d: &[f64; 3], inv: &[[f64; 3]; 3], dim: usize) -> [f64; 3] {
    let mut g = [0.0; 3];
    for (i, gi) in g.iter_mut().enumerate().take(dim) {
        *gi = (0..dim).map(|k| d[k] * inv[k][i]).sum();
    }
    g
}

/// Writes the six Voigt rows of one column of `B`: the column carries displacement component
/// `comp` and the gradient `g`.
fn fill_b(b: &mut [f64], nt: usize, col: usize, comp: usize, g: [f64; 3], dim: usize) {
    for (row, i, j) in B_MAP {
        if i == comp && j < dim {
            b[row * nt + col] = g[j];
        }
    }
}

/// Everything the integrals need at every Gauss point. `b` holds the augmented strain matrix
/// `[B | B̄_α]`: `n_gp` blocks of `VOIGT × nt` row-major, with `m` incompatible-mode columns
/// after the `n_dof` displacement columns.
struct Kin {
    n_gp: usize,
    n_nodes: usize,
    dim: usize,
    n_dof: usize,
    m: usize,
    b: Vec<f64>,
    /// `n_gp * n_nodes` shape values.
    n: Vec<f64>,
    /// `w · det J · scale` per Gauss point.
    w: Vec<f64>,
    /// Physical coordinates of each Gauss point.
    x: Vec<[f64; 3]>,
    min_det: f64,
}

impl Kin {
    fn nt(&self) -> usize {
        self.n_dof + self.m
    }
    fn b_at(&self, g: usize) -> &[f64] {
        let s = VOIGT * self.nt();
        &self.b[g * s..(g + 1) * s]
    }
}

/// `B`, the weights, the shape values and the Gauss-point positions of one element.
///
/// The incompatible modes are the bubbles `P_k(ξ) = 1 − ξ_k²`, each multiplying every
/// displacement component, differentiated through the *centroid* Jacobian and corrected by
/// `B̄_α = B_α − (1/V) ∫ B_α dV` (Taylor–Beresford–Wilson), which is what makes a constant
/// strain field unable to excite them and the patch test pass on a distorted element.
fn kinematics(kind: ElementKind, c: &ElementCtx<'_>) -> Result<Kin, Error> {
    kinematics_with_rule(kind, c, rule_of(kind))
}

fn kinematics_with_rule(kind: ElementKind, c: &ElementCtx<'_>, rule: Rule) -> Result<Kin, Error> {
    let (nn, dim) = (kind.n_nodes(), kind.dim());
    let n_gp = rule.points.len();
    let n_dof = nn * dim;
    let m = n_modes(kind, c.formulation);
    let nt = n_dof + m;
    let mut kin = Kin {
        n_gp,
        n_nodes: nn,
        dim,
        n_dof,
        m,
        b: vec![0.0; n_gp * VOIGT * nt],
        n: vec![0.0; n_gp * nn],
        w: vec![0.0; n_gp],
        x: vec![[0.0; 3]; n_gp],
        min_det: f64::INFINITY,
    };
    let mut dn = vec![[0.0; 3]; nn];
    let mut sh = vec![0.0; nn];
    // The incompatible modes are differentiated at the centroid; nothing else needs J₀.
    let inv0 = if m > 0 {
        dshape_of(kind, centre_xi(kind), &mut dn);
        jac_inv(dim, c.coords, &dn).ok_or_else(inverted)?.0
    } else {
        [[0.0; 3]; 3]
    };
    for g in 0..n_gp {
        let xi = rule.points[g];
        shape_of(kind, xi, &mut sh);
        dshape_of(kind, xi, &mut dn);
        let (inv, det) = jac_inv(dim, c.coords, &dn).ok_or_else(inverted)?;
        kin.min_det = kin.min_det.min(det);
        let mut xg = [0.0; 3];
        for (a, &n) in sh.iter().enumerate() {
            for (i, xi_) in xg.iter_mut().enumerate().take(dim) {
                *xi_ += n * c.coords[3 * a + i];
            }
        }
        kin.w[g] = rule.weights[g] * det * scale_at(&c.idealisation, xg);
        kin.x[g] = xg;
        kin.n[g * nn..(g + 1) * nn].copy_from_slice(&sh);
        let bg = &mut kin.b[g * VOIGT * nt..(g + 1) * VOIGT * nt];
        for (a, d) in dn.iter().enumerate() {
            let grad = grad_of(d, &inv, dim);
            for i in 0..dim {
                fill_b(bg, nt, dim * a + i, i, grad, dim);
            }
        }
        for p in 0..m {
            let (k, i) = (p / dim, p % dim);
            let f = -2.0 * xi[k];
            let mut g_alpha = [0.0; 3];
            for (q, gq) in g_alpha.iter_mut().enumerate().take(dim) {
                *gq = f * inv0[k][q];
            }
            fill_b(bg, nt, n_dof + p, i, g_alpha, dim);
        }
        if let Idealisation::Axisymmetric = c.idealisation {
            let r = xg[0];
            for (a, &n) in sh.iter().enumerate() {
                bg[2 * nt + dim * a] = n / r;
            }
            for p in (0..m).step_by(dim) {
                let k = p / dim;
                bg[2 * nt + n_dof + p] = (1.0 - xi[k] * xi[k]) / r;
            }
        }
    }
    if m > 0 {
        let vol: f64 = kin.w.iter().sum();
        for row in 0..VOIGT {
            for p in 0..m {
                let at = |g: usize| g * VOIGT * nt + row * nt + n_dof + p;
                let mean = (0..n_gp).map(|g| kin.w[g] * kin.b[at(g)]).sum::<f64>() / vol;
                for g in 0..n_gp {
                    kin.b[at(g)] -= mean;
                }
            }
        }
    }
    Ok(kin)
}

/// Stress and the 6×6 tangent at every Gauss point, through the idealisation's path: plane
/// stress condenses ε₃₃ away and pads the 3×3 answer back into Voigt rows 11, 22, 12; every
/// other idealisation calls the 3D law once with the whole batch.
fn constitutive(
    c: &ElementCtx<'_>,
    n: usize,
    strain: &[f64],
    stress: &mut [f64],
    tangent: &mut [f64],
) -> Result<(), Error> {
    let law = c.material.law;
    if let Idealisation::PlaneStress { .. } = c.idealisation {
        let mut e2 = vec![0.0; n * 3];
        for p in 0..n {
            for (a, &i) in PLANE.iter().enumerate() {
                e2[p * 3 + a] = strain[p * VOIGT + i];
            }
        }
        let (mut s3, mut t9) = (vec![0.0; n * 3], vec![0.0; n * 9]);
        plane_stress_condense(law, &c.material.props, &e2, &mut s3, &mut t9)?;
        stress.fill(0.0);
        tangent.fill(0.0);
        for p in 0..n {
            for (a, &i) in PLANE.iter().enumerate() {
                stress[p * VOIGT + i] = s3[p * 3 + a];
                for (b, &j) in PLANE.iter().enumerate() {
                    tangent[p * VOIGT * VOIGT + i * VOIGT + j] = t9[p * 9 + a * 3 + b];
                }
            }
        }
        return Ok(());
    }
    let zeros = vec![0.0; n * VOIGT];
    let state_in = vec![0.0; n * law.n_state()];
    let mut state_out = vec![0.0; n * law.n_state()];
    let batch = MaterialBatch {
        n,
        strain,
        dstrain: &zeros,
        temperature: &zeros[..n],
        dt: 0.0,
        props: &c.material.props,
        state_in: &state_in,
    };
    law.evaluate(batch, MaterialOut { stress, tangent, state_out: &mut state_out })
}

/// The tangent at zero strain: what the stiffness, the thermal load and the mode condensation
/// all integrate against for a linear law.
pub(crate) fn tangent_at_zero(c: &ElementCtx<'_>, n: usize) -> Result<Vec<f64>, Error> {
    let zeros = vec![0.0; n * VOIGT];
    let (mut s, mut d) = (vec![0.0; n * VOIGT], vec![0.0; n * VOIGT * VOIGT]);
    constitutive(c, n, &zeros, &mut s, &mut d)?;
    Ok(d)
}

/// `K̂ = Σ w B̂ᵀ D B̂` over the augmented columns, `nt × nt` row-major.
fn augmented_k(kin: &Kin, d: &[f64]) -> Vec<f64> {
    let nt = kin.nt();
    let mut k = vec![0.0; nt * nt];
    let mut db = vec![0.0; VOIGT * nt];
    for g in 0..kin.n_gp {
        let b = kin.b_at(g);
        let dg = &d[g * VOIGT * VOIGT..(g + 1) * VOIGT * VOIGT];
        for i in 0..VOIGT {
            for col in 0..nt {
                db[i * nt + col] = (0..VOIGT).map(|j| dg[i * VOIGT + j] * b[j * nt + col]).sum();
            }
        }
        for r in 0..nt {
            for col in 0..nt {
                k[r * nt + col] += kin.w[g] * (0..VOIGT).map(|i| b[i * nt + r] * db[i * nt + col]).sum::<f64>();
            }
        }
    }
    k
}

/// `rhs ← K_αα⁻¹ rhs` (`m × cols`, row-major) by Cholesky. `K_αα` is positive definite for any
/// element whose Jacobian is positive, which `kinematics` has already established.
fn solve_alpha(kk: &[f64], kin: &Kin, rhs: &mut [f64], cols: usize) {
    let (nt, m, nd) = (kin.nt(), kin.m, kin.n_dof);
    let mut a = vec![0.0; m * m];
    for p in 0..m {
        for q in 0..m {
            a[p * m + q] = kk[(nd + p) * nt + nd + q];
        }
    }
    for i in 0..m {
        for j in 0..=i {
            let mut s = a[i * m + j];
            for k in 0..j {
                s -= a[i * m + k] * a[j * m + k];
            }
            a[i * m + j] = if i == j { s.sqrt() } else { s / a[j * m + j] };
        }
    }
    for c in 0..cols {
        for i in 0..m {
            let mut s = rhs[i * cols + c];
            for k in 0..i {
                s -= a[i * m + k] * rhs[k * cols + c];
            }
            rhs[i * cols + c] = s / a[i * m + i];
        }
        for i in (0..m).rev() {
            let mut s = rhs[i * cols + c];
            for k in i + 1..m {
                s -= a[k * m + i] * rhs[k * cols + c];
            }
            rhs[i * cols + c] = s / a[i * m + i];
        }
    }
}

/// `K_uu − K_uα K_αα⁻¹ K_αu` into `k` (`n_dof × n_dof`); a plain copy when there are no modes.
fn condense_k(kk: &[f64], kin: &Kin, k: &mut [f64]) {
    let (nt, nd, m) = (kin.nt(), kin.n_dof, kin.m);
    for r in 0..nd {
        k[r * nd..(r + 1) * nd].copy_from_slice(&kk[r * nt..r * nt + nd]);
    }
    if m > 0 {
        let mut x = vec![0.0; m * nd];
        for p in 0..m {
            for col in 0..nd {
                x[p * nd + col] = kk[(nd + p) * nt + col];
            }
        }
        solve_alpha(kk, kin, &mut x, nd);
        for r in 0..nd {
            for col in 0..nd {
                k[r * nd + col] -= (0..m).map(|p| kk[r * nt + nd + p] * x[p * nd + col]).sum::<f64>();
            }
        }
    }
}

/// Nodal temperature rise at every Gauss point, or `None` when the context has no temperature.
fn delta_t(kin: &Kin, c: &ElementCtx<'_>) -> Option<Vec<f64>> {
    let t = c.temperature?;
    Some(
        (0..kin.n_gp)
            .map(|g| (0..kin.n_nodes).map(|a| kin.n[g * kin.n_nodes + a] * (t[a] - c.t_ref)).sum::<f64>())
            .collect(),
    )
}

/// `ε_th = α ΔT` on the three normal components at every Gauss point.
fn thermal_strain(kin: &Kin, c: &ElementCtx<'_>) -> Option<Vec<f64>> {
    let dt = delta_t(kin, c)?;
    let mut e = vec![0.0; kin.n_gp * VOIGT];
    for (g, &d) in dt.iter().enumerate() {
        for i in 0..3 {
            e[g * VOIGT + i] = c.material.alpha * d;
        }
    }
    Some(e)
}

/// `Σ w B̂ᵀ σ` over the augmented columns.
fn internal_force(kin: &Kin, stress: &[f64]) -> Vec<f64> {
    let nt = kin.nt();
    let mut f = vec![0.0; nt];
    for g in 0..kin.n_gp {
        let b = kin.b_at(g);
        for (col, fc) in f.iter_mut().enumerate() {
            *fc += kin.w[g] * (0..VOIGT).map(|i| b[i * nt + col] * stress[g * VOIGT + i]).sum::<f64>();
        }
    }
    f
}

fn stiffness_of(kind: ElementKind, c: &ElementCtx<'_>, k: &mut [f64]) -> Result<f64, Error> {
    let kin = kinematics(kind, c)?;
    let d = tangent_at_zero(c, kin.n_gp)?;
    condense_k(&augmented_k(&kin, &d), &kin, k);
    Ok(kin.min_det)
}

fn mass_of(kind: ElementKind, c: &ElementCtx<'_>, m: &mut [f64], lumped: bool) -> Result<(), Error> {
    let kin = kinematics_with_rule(kind, c, product_rule_of(kind))?;
    let (nn, dim, nd) = (kin.n_nodes, kin.dim, kin.n_dof);
    m.fill(0.0);
    // A material without `rho` resolves to zero density. Its consistent and lumped element
    // masses are both the exact zero matrix; in particular HRZ must not evaluate 0 / 0.
    if density(c)? == 0.0 {
        return Ok(());
    }
    for g in 0..kin.n_gp {
        let n = &kin.n[g * nn..(g + 1) * nn];
        let wr = kin.w[g] * c.material.rho;
        for a in 0..nn {
            for b in 0..nn {
                let v = wr * n[a] * n[b];
                for i in 0..dim {
                    m[(dim * a + i) * nd + dim * b + i] += v;
                }
            }
        }
    }
    if lumped {
        // HRZ: keep the diagonal, scale it so the total is ρV again. Positive for every kind,
        // which plain row summing is not for hex20 and tet10.
        let total: f64 = kin.w.iter().sum::<f64>() * c.material.rho;
        let diag: Vec<f64> = (0..nd).map(|i| m[i * nd + i]).collect();
        let trace: f64 = (0..nn).map(|a| diag[dim * a]).sum();
        m.fill(0.0);
        for i in 0..nd {
            m[i * nd + i] = diag[i] * total / trace;
        }
    }
    Ok(())
}

fn body_load_of(
    kind: ElementKind,
    c: &ElementCtx<'_>,
    f: &dyn Fn([f64; 3]) -> [f64; 3],
    out: &mut [f64],
) -> Result<(), Error> {
    let kin = kinematics(kind, c)?;
    out.fill(0.0);
    for g in 0..kin.n_gp {
        let fv = f(kin.x[g]);
        for a in 0..kin.n_nodes {
            let n = kin.n[g * kin.n_nodes + a] * kin.w[g];
            for i in 0..kin.dim {
                out[kin.dim * a + i] += n * fv[i];
            }
        }
    }
    Ok(())
}

fn thermal_load_of(kind: ElementKind, c: &ElementCtx<'_>, out: &mut [f64]) -> Result<(), Error> {
    let kin = kinematics(kind, c)?;
    out.fill(0.0);
    let Some(eps) = thermal_strain(&kin, c) else {
        return Ok(());
    };
    let d = tangent_at_zero(c, kin.n_gp)?;
    let mut sig = vec![0.0; kin.n_gp * VOIGT];
    for g in 0..kin.n_gp {
        let dg = &d[g * VOIGT * VOIGT..(g + 1) * VOIGT * VOIGT];
        for i in 0..VOIGT {
            sig[g * VOIGT + i] = (0..VOIGT).map(|j| dg[i * VOIGT + j] * eps[g * VOIGT + j]).sum();
        }
    }
    let f = internal_force(&kin, &sig);
    out.copy_from_slice(&f[..kin.n_dof]);
    if kin.m > 0 {
        // Condense the internal modes out of the load too, so K_condensed u = f_condensed is
        // the same system as the uncondensed one.
        let kk = augmented_k(&kin, &d);
        let mut fa: Vec<f64> = f[kin.n_dof..].to_vec();
        solve_alpha(&kk, &kin, &mut fa, 1);
        for (r, o) in out.iter_mut().enumerate() {
            *o -= (0..kin.m).map(|p| kk[r * kin.nt() + kin.n_dof + p] * fa[p]).sum::<f64>();
        }
    }
    Ok(())
}

/// Loaded area through the same boundary quadrature as pressure and traction. This needs no
/// material: plane stress includes thickness, axisymmetry includes 2πr, and plane strain
/// uses the solver's unit-depth convention.
pub(crate) fn loaded_face_measure(mesh: &Mesh, face: Face, idealisation: &Idealisation) -> f64 {
    let kind = mesh.kind_of(face.elem);
    let mut coords = vec![0.0; kind.n_nodes() * 3];
    mesh.elem_coords(face.elem, &mut coords);
    let mut force = vec![0.0; kind.n_nodes() * kind.dim()];
    face_load_of(kind, &coords, idealisation, face.local, FaceLoad::Traction([1.0, 0.0, 0.0]), &mut force);
    force.iter().step_by(kind.dim()).sum()
}

fn face_load_of(
    kind: ElementKind,
    coords: &[f64],
    idealisation: &Idealisation,
    local_face: u8,
    load: FaceLoad,
    out: &mut [f64],
) {
    let dim = kind.dim();
    let fk = kind.face_kind();
    let nodes = kind.face_nodes(local_face as usize);
    let rule = face_rule_of(fk);
    let mut sh = vec![0.0; fk.n_nodes()];
    let mut ds = vec![[0.0; 2]; fk.n_nodes()];
    out.fill(0.0);
    for (g, p) in rule.points.iter().enumerate() {
        let s = [p[0], p[1]];
        face_shape_of(fk, s, &mut sh);
        face_dshape_of(fk, s, &mut ds);
        // tangents and the physical point of this face quadrature point
        let mut t = [[0.0f64; 3]; 2];
        let mut x = [0.0; 3];
        for (i, &node) in nodes.iter().enumerate() {
            let xc = &coords[3 * node as usize..3 * node as usize + 3];
            for k in 0..3 {
                x[k] += sh[i] * xc[k];
                t[0][k] += ds[i][0] * xc[k];
                t[1][k] += ds[i][1] * xc[k];
            }
        }
        // `area` is the outward normal times the Jacobian of the face map: the cross product of
        // the two tangents in 3D, the tangent rotated by −90° in 2D.
        let area = if dim == 3 {
            [
                t[0][1] * t[1][2] - t[0][2] * t[1][1],
                t[0][2] * t[1][0] - t[0][0] * t[1][2],
                t[0][0] * t[1][1] - t[0][1] * t[1][0],
            ]
        } else {
            [t[0][1], -t[0][0], 0.0]
        };
        let jac = (area[0] * area[0] + area[1] * area[1] + area[2] * area[2]).sqrt();
        let w = rule.weights[g] * scale_at(idealisation, x);
        let traction = match load {
            FaceLoad::Pressure(p) => [-p * area[0] / jac, -p * area[1] / jac, -p * area[2] / jac],
            FaceLoad::Traction(t) => t,
        };
        for (i, &node) in nodes.iter().enumerate() {
            for k in 0..dim {
                out[dim * node as usize + k] += sh[i] * traction[k] * jac * w;
            }
        }
    }
}

fn recover_of(
    kind: ElementKind,
    c: &ElementCtx<'_>,
    u: &[f64],
    stress: &mut [f64],
    strain: &mut [f64],
) -> Result<(), Error> {
    let kin = kinematics(kind, c)?;
    let (nt, nd, m) = (kin.nt(), kin.n_dof, kin.m);
    let mut uhat = vec![0.0; nt];
    uhat[..nd].copy_from_slice(&u[..nd]);
    if m > 0 {
        // α = −K_αα⁻¹ K_αu u
        let kk = augmented_k(&kin, &tangent_at_zero(c, kin.n_gp)?);
        let mut y: Vec<f64> = (0..m).map(|p| (0..nd).map(|col| kk[(nd + p) * nt + col] * u[col]).sum()).collect();
        solve_alpha(&kk, &kin, &mut y, 1);
        for (p, v) in y.iter().enumerate() {
            uhat[nd + p] = -v;
        }
    }
    for g in 0..kin.n_gp {
        let b = kin.b_at(g);
        for i in 0..VOIGT {
            strain[g * VOIGT + i] = (0..nt).map(|col| b[i * nt + col] * uhat[col]).sum();
        }
    }
    let mut mech = strain[..kin.n_gp * VOIGT].to_vec();
    if let Some(eps) = thermal_strain(&kin, c) {
        for (a, b) in mech.iter_mut().zip(eps.iter()) {
            *a -= b;
        }
    }
    let mut tangent = vec![0.0; kin.n_gp * VOIGT * VOIGT];
    constitutive(c, kin.n_gp, &mech, stress, &mut tangent)
}

/// The smallest Gauss-point `det J` of one element's coordinates, or `None` when the element
/// is folded at one of them. The well-posedness check screens a whole Mesh with this before
/// any material is looked at, and it is the same Jacobian the integrals use.
pub fn min_det_j(kind: ElementKind, coords: &[f64]) -> Option<f64> {
    // A line member is embedded in the mesh's space, so its Jacobian is the length of
    // `dx/dξ` rather than a determinant of the coordinate directions.
    if kind == ElementKind::Truss2 {
        return crate::fem::truss::axis(coords).map(|(_, half)| half);
    }
    let (nn, dim) = (kind.n_nodes(), kind.dim());
    let rule = rule_of(kind);
    let mut dn = vec![[0.0; 3]; nn];
    let mut min = f64::INFINITY;
    for &xi in rule.points {
        dshape_of(kind, xi, &mut dn);
        min = min.min(jac_inv(dim, coords, &dn)?.1);
    }
    Some(min)
}

fn inverse_map_status_of(kind: ElementKind, coords: &[f64], x: [f64; 3]) -> InverseMap {
    let (nn, dim) = (kind.n_nodes(), kind.dim());
    let mut scaled_span = 0.0f64;
    let mut magnitude = 0.0f64;
    for k in 0..dim {
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for point in coords.chunks_exact(3) {
            lo = lo.min(point[k]);
            hi = hi.max(point[k]);
        }
        if !(lo.is_finite() && hi.is_finite() && x[k].is_finite()) {
            return InverseMap::Failed;
        }
        // Scale before subtracting: finite opposite-sign extrema can make `hi - lo`
        // overflow even though the physical-coordinate tolerance remains representable.
        scaled_span = scaled_span.max(1e-12 * hi - 1e-12 * lo);
        magnitude = magnitude.max(lo.abs()).max(hi.abs()).max(x[k].abs());
    }
    // The relative term follows the physical element size; the epsilon term covers subtraction
    // when a small element is far from the origin. Both are physical-coordinate tolerances.
    let residual_tolerance = scaled_span + 64.0 * f64::EPSILON * magnitude;
    let mut xi = centre_xi(kind);
    let mut sh = vec![0.0; nn];
    let mut dn = vec![[0.0; 3]; nn];
    for iteration in 0..=20 {
        shape_of(kind, xi, &mut sh);
        dshape_of(kind, xi, &mut dn);
        let Some((inv, _)) = jac_inv(dim, coords, &dn) else {
            return InverseMap::Failed;
        };
        let mut r = [0.0; 3];
        for (i, ri) in r.iter_mut().enumerate().take(dim) {
            *ri = x[i] - (0..nn).map(|a| sh[a] * coords[3 * a + i]).sum::<f64>();
        }
        if r.iter().take(dim).all(|value| value.abs() <= residual_tolerance) {
            return if in_reference(kind, xi, 1e-8) { InverseMap::Inside(xi) } else { InverseMap::Outside };
        }
        if iteration < 20 {
            let mut delta = [0.0; 3];
            for k in 0..dim {
                delta[k] = (0..dim).map(|i| inv[k][i] * r[i]).sum::<f64>();
            }
            // A bounded step keeps Newton inside the locally valid neighbourhood of a curved
            // quadratic map. Linear maps retain their exact one-step inversion, including far
            // outside points.
            let trust = if kind.n_nodes() > kind.n_corners() {
                let largest = delta.iter().take(dim).fold(0.0f64, |value, component| value.max(component.abs()));
                (0.5 / largest).min(1.0)
            } else {
                1.0
            };
            for k in 0..dim {
                xi[k] += trust * delta[k];
            }
            if xi.iter().take(dim).any(|value| !value.is_finite()) {
                return InverseMap::Failed;
            }
        }
    }
    InverseMap::Failed
}

fn omega_max_of(kind: ElementKind, c: &ElementCtx<'_>) -> Result<f64, Error> {
    let n = kind.n_nodes() * kind.dim();
    let mut k = vec![0.0; n * n];
    let mut mm = vec![0.0; n * n];
    // One `?`: the two integrals fail on exactly the same elements and materials.
    stiffness_of(kind, c, &mut k).and_then(|_| mass_of(kind, c, &mut mm, true))?;
    if c.material.rho == 0.0 {
        return Err(no_density());
    }
    Ok(omega_max_power(&k, &mm, n))
}

/// `√λ_max` of `M_lumped⁻¹ K` by fifty power iterations from a fixed deterministic start, then
/// the Rayleigh quotient. `k` is `n × n` row-major and `m` holds the lumped mass on its
/// diagonal; every element kind's `omega_max` ends here.
pub(crate) fn omega_max_power(k: &[f64], m: &[f64], n: usize) -> f64 {
    let minv: Vec<f64> = (0..n).map(|i| 1.0 / m[i * n + i]).collect();
    let mut v: Vec<f64> = (0..n).map(|i| libm::sin(i as f64 + 1.0)).collect();
    for _ in 0..50 {
        let w: Vec<f64> = (0..n).map(|i| minv[i] * (0..n).map(|j| k[i * n + j] * v[j]).sum::<f64>()).collect();
        let norm = w.iter().map(|x| x * x).sum::<f64>().sqrt();
        v = w.iter().map(|x| x / norm).collect();
    }
    let num: f64 = (0..n).map(|i| v[i] * (0..n).map(|j| k[i * n + j] * v[j]).sum::<f64>()).sum();
    let den: f64 = (0..n).map(|i| v[i] * v[i] / minv[i]).sum();
    (num / den).sqrt()
}

// ------------------------------------------------------------------ the built-in

/// The isoparametric solid: one implementation for all eight reference elements. Every method
/// forwards to the free function for `R::KIND`, so the eight instantiations are eight vtables
/// over one copy of the numerics.
pub struct Iso<R: RefElement>(PhantomData<R>);

impl<R: RefElement> Element for Iso<R> {
    fn kind(&self) -> ElementKind {
        R::KIND
    }
    fn n_dof(&self) -> usize {
        R::N * R::DIM
    }
    fn n_gp(&self) -> usize {
        rule_of(R::KIND).points.len()
    }
    fn stiffness(&self, c: &ElementCtx<'_>, k: &mut [f64]) -> Result<f64, Error> {
        stiffness_of(R::KIND, c, k)
    }
    fn mass(&self, c: &ElementCtx<'_>, m: &mut [f64], lumped: bool) -> Result<(), Error> {
        mass_of(R::KIND, c, m, lumped)
    }
    fn body_load(&self, c: &ElementCtx<'_>, f: &dyn Fn([f64; 3]) -> [f64; 3], out: &mut [f64]) -> Result<(), Error> {
        body_load_of(R::KIND, c, f, out)
    }
    fn thermal_load(&self, c: &ElementCtx<'_>, out: &mut [f64]) -> Result<(), Error> {
        thermal_load_of(R::KIND, c, out)
    }
    fn face_load(&self, c: &ElementCtx<'_>, local_face: u8, load: FaceLoad, out: &mut [f64]) -> Result<(), Error> {
        face_load_of(R::KIND, c.coords, &c.idealisation, local_face, load, out);
        Ok(())
    }
    fn recover(&self, c: &ElementCtx<'_>, u: &[f64], stress: &mut [f64], strain: &mut [f64]) -> Result<(), Error> {
        recover_of(R::KIND, c, u, stress, strain)
    }
    fn gp_xi(&self, i: usize) -> [f64; 3] {
        rule_of(R::KIND).points[i]
    }
    fn shape_at(&self, xi: [f64; 3], n: &mut [f64]) {
        shape_of(R::KIND, xi, n)
    }
    fn inverse_map(&self, coords: &[f64], x: [f64; 3]) -> Option<[f64; 3]> {
        match inverse_map_status_of(R::KIND, coords, x) {
            InverseMap::Inside(xi) => Some(xi),
            InverseMap::Outside | InverseMap::Failed => None,
        }
    }
    fn inverse_map_status(&self, coords: &[f64], x: [f64; 3]) -> InverseMap {
        inverse_map_status_of(R::KIND, coords, x)
    }
    fn omega_max(&self, c: &ElementCtx<'_>) -> Result<f64, Error> {
        omega_max_of(R::KIND, c)
    }
}

static TRUSS2: crate::fem::truss::Truss2 = crate::fem::truss::Truss2;
static ISO_HEX8: Iso<Hex8> = Iso(PhantomData);
static ISO_HEX20: Iso<Hex20> = Iso(PhantomData);
static ISO_TET4: Iso<Tet4> = Iso(PhantomData);
static ISO_TET10: Iso<Tet10> = Iso(PhantomData);
static ISO_QUAD4: Iso<Quad4> = Iso(PhantomData);
static ISO_QUAD8: Iso<Quad8> = Iso(PhantomData);
static ISO_TRI3: Iso<Tri3> = Iso(PhantomData);
static ISO_TRI6: Iso<Tri6> = Iso(PhantomData);

/// The built-in element for a mesh kind.
pub fn element_for(kind: ElementKind) -> &'static dyn Element {
    match kind {
        ElementKind::Hex8 => &ISO_HEX8,
        ElementKind::Hex20 => &ISO_HEX20,
        ElementKind::Tet4 => &ISO_TET4,
        ElementKind::Tet10 => &ISO_TET10,
        ElementKind::Quad4 => &ISO_QUAD4,
        ElementKind::Quad8 => &ISO_QUAD8,
        ElementKind::Tri3 => &ISO_TRI3,
        ElementKind::Tri6 => &ISO_TRI6,
        ElementKind::Truss2 => &TRUSS2,
    }
}
