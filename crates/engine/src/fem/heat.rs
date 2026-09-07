//! The heat kernels: conduction, capacity, a volumetric source, and the two face integrals a
//! convection or flux boundary needs (plan A §3.3, §3.4).
//!
//! One unknown per node, the same reference elements and integral-specific quadrature as the
//! isoparametric solid, and the same Jacobian routine — [`jac_inv`] and [`scale_at`] are
//! shared with [`element`](crate::fem::element), so an axisymmetric heat problem picks up its
//! `2π r` weight from the one place that knows about it and a folded element is the same
//! `mesh.inverted` error here as there.
//!
//! There is no `HeatElement` trait: there is one implementation, the Element Extension Point
//! already carries the shape functions a plugin would need, and a trait with a single
//! implementation is a seam nobody crosses.

use femlab_geometry::mesh::ElementKind;

use crate::error::Error;
use crate::fem::element::{grad_of, inverted, jac_inv, scale_at, ElementCtx};
use crate::fem::quadrature::Rule;
use crate::fem::shape::{dshape_of, face_dshape_of, face_rule_of, face_shape_of, product_rule_of, rule_of, shape_of};

/// The Stefan-Boltzmann constant, W/(m^2 K^4). Exact in the 2019 SI: it is a defined
/// combination of the fixed values of `k`, `h` and `c`, so it is a constant of the engine and
/// never a user-supplied material property.
pub const STEFAN_BOLTZMANN: f64 = 5.670_374_419e-8;

/// The radiative film at temperature `t`: `(h, h * T_ref)`, the Newton linearisation of
/// `sigma eps (T^4 - Tinf^4)` about `t`.
///
/// The film is the tangent `h = 4 sigma eps t^3`, and the reference temperature is chosen so the
/// flux the assembled system removes at `t` is *exactly* the fourth-power law:
/// `h t - h T_ref == sigma eps (t^4 - Tinf^4)`, i.e. `h T_ref = sigma eps (3 t^4 + Tinf^4)`. So
/// the linearisation leaves nothing behind once the iteration has converged - the answer solves
/// the fourth-power law itself - and `h >= 0` at every absolute temperature keeps the added face
/// matrix positive semi-definite, so the factorisation lives at every iterate.
///
/// The secant film `sigma eps (T + Tinf)(T^2 + Tinf^2)` has the same exactness property and one
/// multiplication less, but its fixed-point map has derivative about `-3 (T - Tinf) / T`
/// wherever radiation rather than conduction sets the surface temperature, so it stalls or
/// diverges exactly where a radiating body is interesting. The tangent costs the same and
/// converges quadratically.
pub fn radiative_film(emissivity: f64, t_inf: f64, t: f64) -> (f64, f64) {
    let se = STEFAN_BOLTZMANN * emissivity;
    (4.0 * se * t * t * t, se * (3.0 * t * t * t * t + t_inf * t_inf * t_inf * t_inf))
}

/// One resolved heat load. Unlike the structural [`Load`](crate::fem::loads::Load)s these are
/// intensive already — a film coefficient, a flux per unit area, a source per unit volume — so
/// nothing is divided by a Set measure on the way in.
#[derive(Debug, Clone, PartialEq)]
pub enum HeatLoad {
    /// Newton cooling on a face Set: `h (T − T∞)` leaves the surface, so the face contributes
    /// `h ∫ NᵀN dS` to the conductivity and `h T∞ ∫ N dS` to the load.
    Convection { faces: String, h: f64, t_inf: f64 },
    /// A prescribed heat flux into a face Set, in W/m².
    Flux { faces: String, q: f64 },
    /// A volumetric heat source over whole Bodies, in W/m³.
    Source { bodies: Vec<String>, q: f64 },
    /// Grey-body radiation from a face Set to a large surrounding at `t_inf`: the surface loses
    /// `sigma eps (T^4 - Tinf^4)` per unit area. Both temperatures are absolute.
    Radiation { faces: String, emissivity: f64, t_inf: f64 },
    /// A finite conductance across the bonded contact `of`: `h (T_slave − T_master)` crosses the
    /// interface per unit area, so the two sides are no longer at the same temperature. `of`
    /// names a Coupling rather than a Set — the interface it acts on comes from the tie's own
    /// slave faces — which is why [`HeatLoad::set`] answers `None` for it, unlike every other
    /// variant here.
    Contact { of: String, h: f64 },
}

impl HeatLoad {
    /// The face Set this load acts on, if it acts on one. A thermal contact names a Coupling,
    /// not a Set, so it is not one of the Sets [`crate::fem::checks::all`] checks here.
    pub fn set(&self) -> Option<&str> {
        match self {
            HeatLoad::Convection { faces, .. } | HeatLoad::Flux { faces, .. } | HeatLoad::Radiation { faces, .. } => {
                Some(faces)
            }
            HeatLoad::Source { .. } | HeatLoad::Contact { .. } => None,
        }
    }
}

/// Shape values, physical gradients and weights at every Gauss point of one element.
struct Kin {
    n_gp: usize,
    n_nodes: usize,
    /// `n_gp * n_nodes` shape values.
    n: Vec<f64>,
    /// `n_gp * n_nodes` physical gradients.
    g: Vec<[f64; 3]>,
    /// `w · det J · scale` per Gauss point.
    w: Vec<f64>,
    min_det: f64,
}

/// The Jacobian, the gradients and the weights of one element, or the folded-element error.
fn kinematics(kind: ElementKind, c: &ElementCtx<'_>, rule: Rule) -> Result<Kin, Error> {
    let (nn, dim) = (kind.n_nodes(), kind.dim());
    let n_gp = rule.points.len();
    let mut kin = Kin {
        n_gp,
        n_nodes: nn,
        n: vec![0.0; n_gp * nn],
        g: vec![[0.0; 3]; n_gp * nn],
        w: vec![0.0; n_gp],
        min_det: f64::INFINITY,
    };
    let mut dn = vec![[0.0; 3]; nn];
    let mut sh = vec![0.0; nn];
    for gp in 0..n_gp {
        let xi = rule.points[gp];
        shape_of(kind, xi, &mut sh);
        dshape_of(kind, xi, &mut dn);
        let (inv, det) = jac_inv(dim, c.coords, &dn).ok_or_else(inverted)?;
        kin.min_det = kin.min_det.min(det);
        let mut x = [0.0; 3];
        for (a, &n) in sh.iter().enumerate() {
            for (i, xi_) in x.iter_mut().enumerate().take(dim) {
                *xi_ += n * c.coords[3 * a + i];
            }
        }
        kin.w[gp] = rule.weights[gp] * det * scale_at(&c.idealisation, x);
        kin.n[gp * nn..(gp + 1) * nn].copy_from_slice(&sh);
        for (a, d) in dn.iter().enumerate() {
            kin.g[gp * nn + a] = grad_of(d, &inv, dim);
        }
    }
    Ok(kin)
}

/// `∫ k ∇Nᵀ ∇N dV` into `out` (`n_nodes × n_nodes`, row-major); returns the smallest
/// Gauss-point `det J`, which the well-posedness report carries just as the stiffness does.
pub fn conductivity(kind: ElementKind, c: &ElementCtx<'_>, out: &mut [f64]) -> Result<f64, Error> {
    let kin = kinematics(kind, c, rule_of(kind))?;
    let nn = kin.n_nodes;
    let dim = kind.dim();
    out.fill(0.0);
    for gp in 0..kin.n_gp {
        let wk = kin.w[gp] * c.material.k;
        for a in 0..nn {
            let ga = kin.g[gp * nn + a];
            for b in 0..nn {
                let gb = kin.g[gp * nn + b];
                out[a * nn + b] += wk * (0..dim).map(|i| ga[i] * gb[i]).sum::<f64>();
            }
        }
    }
    Ok(kin.min_det)
}

/// `∫ ρ c_p Nᵀ N dV` into `out`: the consistent capacity the θ-method integrates with.
pub fn capacity(kind: ElementKind, c: &ElementCtx<'_>, out: &mut [f64]) -> Result<(), Error> {
    let kin = kinematics(kind, c, product_rule_of(kind))?;
    let nn = kin.n_nodes;
    out.fill(0.0);
    for gp in 0..kin.n_gp {
        let w = kin.w[gp] * c.material.rho * c.material.cp;
        let n = &kin.n[gp * nn..(gp + 1) * nn];
        for a in 0..nn {
            for b in 0..nn {
                out[a * nn + b] += w * n[a] * n[b];
            }
        }
    }
    Ok(())
}

/// `∫ q N dV` into `out`: the nodal heat a volumetric source delivers.
pub fn source(kind: ElementKind, c: &ElementCtx<'_>, q: f64, out: &mut [f64]) -> Result<(), Error> {
    let kin = kinematics(kind, c, rule_of(kind))?;
    let nn = kin.n_nodes;
    out.fill(0.0);
    for gp in 0..kin.n_gp {
        for (a, o) in out.iter_mut().enumerate().take(nn) {
            *o += q * kin.w[gp] * kin.n[gp * nn + a];
        }
    }
    Ok(())
}

/// The two face integrals a convection or flux boundary needs: `∫ Nᵀ N dS` into `mat`
/// (`n_nodes × n_nodes` over the *element's* numbering, zero off the face) and `∫ N dS` into
/// `vec`. A convection Set adds `h · mat` to the conductivity and `h T∞ · vec` to the load; a
/// flux Set adds `q · vec`. The face measure is the same one the traction integral uses, so an
/// axisymmetric ring convects over `2π r` per unit length.
pub fn face_integrals(
    kind: ElementKind,
    c: &ElementCtx<'_>,
    local_face: u8,
    mat: &mut [f64],
    out: &mut [f64],
) -> Result<(), Error> {
    face_film(kind, c, local_face, &vec![0.0; kind.n_nodes()], &|_| (1.0, 1.0), mat, out)
}

/// `int h(T) N^T N dS` into `mat` and `int h(T) T_ref(T) N dS` into `vec`, with `film`
/// evaluated at each Gauss point's interpolated temperature and `t_nodes` holding the
/// element's nodal temperatures (`kind.n_nodes()` of them, zero off the face).
///
/// A constant film - convection's `h`, or the `1` [`face_integrals`] passes - reads the
/// temperature and ignores it, so the numbers it produces are bit-for-bit the ones the
/// dedicated convection integral produced before this generalisation; an engine test pins
/// those bits against a captured reference.
pub fn face_film(
    kind: ElementKind,
    c: &ElementCtx<'_>,
    local_face: u8,
    t_nodes: &[f64],
    film: &dyn Fn(f64) -> (f64, f64),
    mat: &mut [f64],
    vec: &mut [f64],
) -> Result<(), Error> {
    let nn = kind.n_nodes();
    let fk = kind.face_kind();
    let nodes = kind.face_nodes(local_face as usize);
    let rule = face_rule_of(fk);
    let mut sh = vec![0.0; fk.n_nodes()];
    let mut ds = vec![[0.0; 2]; fk.n_nodes()];
    mat.fill(0.0);
    vec.fill(0.0);
    for (gp, p) in rule.points.iter().enumerate() {
        let s = [p[0], p[1]];
        face_shape_of(fk, s, &mut sh);
        face_dshape_of(fk, s, &mut ds);
        let mut t = [[0.0f64; 3]; 2];
        let mut x = [0.0; 3];
        for (i, &node) in nodes.iter().enumerate() {
            let xc = &c.coords[3 * node as usize..3 * node as usize + 3];
            for k in 0..3 {
                x[k] += sh[i] * xc[k];
                t[0][k] += ds[i][0] * xc[k];
                t[1][k] += ds[i][1] * xc[k];
            }
        }
        // The face Jacobian: the length of the tangent cross product in 3D, of the tangent
        // itself in 2D — the same measure `face_load` integrates a traction over.
        let area = if kind.dim() == 3 {
            [
                t[0][1] * t[1][2] - t[0][2] * t[1][1],
                t[0][2] * t[1][0] - t[0][0] * t[1][2],
                t[0][0] * t[1][1] - t[0][1] * t[1][0],
            ]
        } else {
            [t[0][1], -t[0][0], 0.0]
        };
        let jac = (area[0] * area[0] + area[1] * area[1] + area[2] * area[2]).sqrt();
        let w = rule.weights[gp] * jac * scale_at(&c.idealisation, x);
        let mut t_gp = 0.0;
        for (i, &node) in nodes.iter().enumerate() {
            t_gp += sh[i] * t_nodes[node as usize];
        }
        let (h, h_t_ref) = film(t_gp);
        for (i, &node) in nodes.iter().enumerate() {
            vec[node as usize] += w * h_t_ref * sh[i];
            for (j, &other) in nodes.iter().enumerate() {
                mat[node as usize * nn + other as usize] += w * h * sh[i] * sh[j];
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{radiative_film, STEFAN_BOLTZMANN};

    /// The linearisation is exact where it is evaluated: the flux the assembled system removes
    /// at `T`, `h(T)·T − h(T)·T_ref`, *is* `σ ε (T⁴ − T∞⁴)`, so a converged iteration solves the
    /// fourth-power law itself with no linearisation error left over.
    #[test]
    fn the_radiative_film_reproduces_the_fourth_power_law_exactly() {
        for &(eps, t_inf, t) in
            &[(0.98, 300.0, 927.0), (1.0, 0.0, 500.0), (0.5, 800.0, 300.0), (0.2, 293.15, 293.15), (1.0, 300.0, 0.0)]
        {
            let (h, h_t_inf) = radiative_film(eps, t_inf, t);
            let flux = h * t - h_t_inf;
            let exact = STEFAN_BOLTZMANN * eps * (t * t * t * t - t_inf * t_inf * t_inf * t_inf);
            // The two fourth powers cancel when the body sits at the surrounding temperature, so
            // the yardstick is the size of the terms, not of their difference.
            let warmest = t.max(t_inf);
            let scale = STEFAN_BOLTZMANN * eps * warmest * warmest * warmest * warmest;
            assert!(libm::fabs(flux - exact) <= 1e-14 * scale, "eps {eps}, T {t}, Tinf {t_inf}: {flux} vs {exact}");
            // Non-negative at every absolute temperature, which is what keeps the face matrix
            // positive semi-definite and the factorisation alive at every iterate.
            assert!(h >= 0.0, "{h}");
        }
        // A body at the surrounding temperature radiates nothing net: the film and its offset
        // cancel, which is what makes an equilibrated face contribute no heat.
        let (h, h_t_ref) = radiative_film(0.9, 400.0, 400.0);
        assert!(libm::fabs(h * 400.0 - h_t_ref) <= 1e-15 * h_t_ref, "{h} against {h_t_ref}");
        // The 2019 SI value, to the digit.
        assert_eq!(STEFAN_BOLTZMANN, 5.670_374_419e-8);
    }
}
