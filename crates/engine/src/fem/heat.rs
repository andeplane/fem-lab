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
}

impl HeatLoad {
    /// The face Set this load acts on, if it acts on one.
    pub fn set(&self) -> Option<&str> {
        match self {
            HeatLoad::Convection { faces, .. } | HeatLoad::Flux { faces, .. } => Some(faces),
            HeatLoad::Source { .. } => None,
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
        for (i, &node) in nodes.iter().enumerate() {
            vec[node as usize] += w * sh[i];
            for (j, &other) in nodes.iter().enumerate() {
                mat[node as usize * nn + other as usize] += w * sh[i] * sh[j];
            }
        }
    }
    Ok(())
}
