//! The two-node truss: a straight member that carries axial force and nothing else.
//!
//! A truss is the degenerate structural element — a bar with `EA/L` along its own axis and no
//! stiffness across it — and it is the reason line geometry exists at all (#66). Its nodes
//! carry the mesh's three translations, so it assembles into exactly the same global numbering
//! as a solid: `Problem::dofs_per_node()` is untouched.
//!
//! Everything is closed form; there is no numerical quadrature to speak of, but the element
//! still goes through the shared reference-element tables (`shape_of`, `dshape_of`, `rule_of`
//! for `Truss2`) rather than inventing its own, so a probe, an extrapolation or a future line
//! element sees the same one-Gauss-point line as this one.
//!
//! Geometry. `dx/dξ` of the isoparametric map is half the vector between the two nodes,
//! whatever direction the member points, so its norm is the curve element's `det J = L/2` and
//! its unit vector is the member's axis `e1`. A zero-length or non-finite member has no axis,
//! which is how `checks::inverted` catches it.
//!
//! Statics. With `t = [−e1, e1]` the stiffness is `(EA/L) t tᵀ`, the consistent mass is
//! `ρAL/6 [[2I, I], [I, 2I]]`, a body force integrates to `A L / 2` at each node, and a
//! temperature rise puts `EAα ΔT` into `t`. Strain is the axial component alone (Voigt row 0)
//! and stress follows from the material's *axial* modulus: the one that relates σ₁₁ to ε₁₁
//! when the other five components vanish, which is what a bar free to contract laterally has.
//! For the isotropic law that is exactly `E`, and taking it from the tangent rather than from
//! the property list keeps the Material Extension Point on the path.

use femlab_geometry::mesh::ElementKind;

use crate::error::{Error, ErrorCode};
use crate::fem::element::{density, inverted, no_density, omega_max_power, tangent_at_zero, Element, ElementCtx};
use crate::fem::material::VOIGT;
use crate::fem::section::Section;
use crate::fem::shape::{centre_xi, dshape_of, in_reference, rule_of, shape_of};

/// Degrees of freedom of one member: three translations at each of two nodes.
const N_DOF: usize = 6;

/// The member's unit axis and half-length, or `None` when it has neither: `dx/dξ` is half the
/// vector between the nodes, so its norm is `det J = L/2` and its direction is the axis.
pub(crate) fn axis(coords: &[f64]) -> Option<([f64; 3], f64)> {
    let mut dn = [[0.0; 3]; 2];
    dshape_of(ElementKind::Truss2, centre_xi(ElementKind::Truss2), &mut dn);
    let mut d = [0.0; 3];
    for (a, g) in dn.iter().enumerate() {
        for (k, dk) in d.iter_mut().enumerate() {
            *dk += coords[3 * a + k] * g[0];
        }
    }
    let half = libm::sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
    if !(half > 0.0 && half.is_finite()) {
        return None;
    }
    Some(([d[0] / half, d[1] / half, d[2] / half], half))
}

/// The midpoint of the member, which is where its single Gauss point sits.
fn midpoint(coords: &[f64]) -> [f64; 3] {
    let mut sh = [0.0; 2];
    shape_of(ElementKind::Truss2, centre_xi(ElementKind::Truss2), &mut sh);
    let mut x = [0.0; 3];
    for (a, &n) in sh.iter().enumerate() {
        for (k, xk) in x.iter_mut().enumerate() {
            *xk += n * coords[3 * a + k];
        }
    }
    x
}

/// The Section of the element, or the `model.no-section` error. `checks::missing_sections`
/// reports the same thing per Body before a solve starts; this is what an element integrated
/// on its own reports.
fn section_of<'a>(c: &ElementCtx<'a>) -> Result<&'a Section, Error> {
    c.section.ok_or_else(|| {
        Error::new(ErrorCode::ModelNoSection, "a line member has no cross-section to carry force over")
            .at("element")
            .suggest("section.add and section.assign on the Body")
    })
}

/// The modulus relating σ₁₁ to ε₁₁ with the other five stress components free, which is
/// `1 / (D⁻¹)₀₀` over the three normal rows: the determinant of that block over its (0,0)
/// cofactor. Exactly `E` for the isotropic law.
fn axial_modulus(c: &ElementCtx<'_>) -> Result<f64, Error> {
    let d = tangent_at_zero(c, 1)?;
    let at = |i: usize, j: usize| d[i * VOIGT + j];
    let det = at(0, 0) * (at(1, 1) * at(2, 2) - at(1, 2) * at(2, 1))
        - at(0, 1) * (at(1, 0) * at(2, 2) - at(1, 2) * at(2, 0))
        + at(0, 2) * (at(1, 0) * at(2, 1) - at(1, 1) * at(2, 0));
    Ok(det / (at(1, 1) * at(2, 2) - at(1, 2) * at(2, 1)))
}

/// Mean temperature rise over the member, or `None` when the Problem has no temperature field.
fn delta_t(c: &ElementCtx<'_>) -> Option<f64> {
    let t = c.temperature?;
    Some(0.5 * (t[0] + t[1]) - c.t_ref)
}

/// The built-in truss; see the module docs.
pub struct Truss2;

impl Element for Truss2 {
    fn kind(&self) -> ElementKind {
        ElementKind::Truss2
    }
    fn n_dof(&self) -> usize {
        N_DOF
    }
    fn n_gp(&self) -> usize {
        rule_of(ElementKind::Truss2).points.len()
    }

    fn stiffness(&self, c: &ElementCtx<'_>, k: &mut [f64]) -> Result<f64, Error> {
        let (e1, half) = axis(c.coords).ok_or_else(inverted)?;
        let ea_l = axial_modulus(c)? * section_of(c)?.a / (2.0 * half);
        let t = [-e1[0], -e1[1], -e1[2], e1[0], e1[1], e1[2]];
        for i in 0..N_DOF {
            for j in 0..N_DOF {
                k[i * N_DOF + j] = ea_l * t[i] * t[j];
            }
        }
        Ok(half)
    }

    fn mass(&self, c: &ElementCtx<'_>, m: &mut [f64], lumped: bool) -> Result<(), Error> {
        let (_, half) = axis(c.coords).ok_or_else(inverted)?;
        let total = density(c)? * section_of(c)?.a * 2.0 * half;
        m.fill(0.0);
        if lumped {
            for i in 0..N_DOF {
                m[i * N_DOF + i] = 0.5 * total;
            }
            return Ok(());
        }
        for a in 0..2 {
            for b in 0..2 {
                let v = total / 6.0 * if a == b { 2.0 } else { 1.0 };
                for i in 0..3 {
                    m[(3 * a + i) * N_DOF + 3 * b + i] = v;
                }
            }
        }
        Ok(())
    }

    fn body_load(&self, c: &ElementCtx<'_>, f: &dyn Fn([f64; 3]) -> [f64; 3], out: &mut [f64]) -> Result<(), Error> {
        let (_, half) = axis(c.coords).ok_or_else(inverted)?;
        let a = section_of(c)?.a;
        let rule = rule_of(ElementKind::Truss2);
        let mut sh = [0.0; 2];
        shape_of(ElementKind::Truss2, rule.points[0], &mut sh);
        let w = rule.weights[0] * half * a;
        let fv = f(midpoint(c.coords));
        for node in 0..2 {
            for i in 0..3 {
                out[3 * node + i] = w * sh[node] * fv[i];
            }
        }
        Ok(())
    }

    fn thermal_load(&self, c: &ElementCtx<'_>, out: &mut [f64]) -> Result<(), Error> {
        out.fill(0.0);
        let Some(dt) = delta_t(c) else {
            return Ok(());
        };
        let (e1, _) = axis(c.coords).ok_or_else(inverted)?;
        let f = axial_modulus(c)? * section_of(c)?.a * c.material.alpha * dt;
        for i in 0..3 {
            out[i] = -f * e1[i];
            out[3 + i] = f * e1[i];
        }
        Ok(())
    }

    fn face_load(
        &self,
        _c: &ElementCtx<'_>,
        _local_face: u8,
        _load: super::element::FaceLoad,
        _out: &mut [f64],
    ) -> Result<(), Error> {
        Err(no_faces())
    }

    fn recover(&self, c: &ElementCtx<'_>, u: &[f64], stress: &mut [f64], strain: &mut [f64]) -> Result<(), Error> {
        let (e1, half) = axis(c.coords).ok_or_else(inverted)?;
        stress.fill(0.0);
        strain.fill(0.0);
        let axial: f64 = (0..3).map(|i| (u[3 + i] - u[i]) * e1[i]).sum::<f64>() / (2.0 * half);
        strain[0] = axial;
        let mechanical = axial - delta_t(c).map_or(0.0, |dt| c.material.alpha * dt);
        stress[0] = axial_modulus(c)? * mechanical;
        Ok(())
    }

    fn gp_xi(&self, i: usize) -> [f64; 3] {
        rule_of(ElementKind::Truss2).points[i]
    }

    fn shape_at(&self, xi: [f64; 3], n: &mut [f64]) {
        shape_of(ElementKind::Truss2, xi, n)
    }

    /// A member is a curve, so a point is mapped by projecting it onto the member's own axis:
    /// a probe or a `query.path` station reads the member at the station nearest the point,
    /// and `None` only once the projection leaves the segment.
    fn inverse_map(&self, coords: &[f64], x: [f64; 3]) -> Option<[f64; 3]> {
        let (e1, half) = axis(coords)?;
        let mid = midpoint(coords);
        let xi = [(0..3).map(|i| (x[i] - mid[i]) * e1[i]).sum::<f64>() / half, 0.0, 0.0];
        in_reference(ElementKind::Truss2, xi, 1e-8).then_some(xi)
    }

    fn omega_max(&self, c: &ElementCtx<'_>) -> Result<f64, Error> {
        let mut k = [0.0; N_DOF * N_DOF];
        let mut m = [0.0; N_DOF * N_DOF];
        // One `?`: the two integrals fail on exactly the same members and materials.
        self.stiffness(c, &mut k).and_then(|_| self.mass(c, &mut m, true))?;
        if c.material.rho == 0.0 {
            return Err(no_density());
        }
        Ok(omega_max_power(&k, &m, N_DOF))
    }
}

/// The `unsupported` error a face load on a line member gets: a member has no face.
pub(crate) fn no_faces() -> Error {
    Error::new(ErrorCode::Unsupported, "a line member has no face: a pressure or traction cannot act on it")
        .at("element")
        .suggest("load.force on a node Set of the member's joints, or load.gravity")
}
