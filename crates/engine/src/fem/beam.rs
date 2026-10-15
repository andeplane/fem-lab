//! The two-node Timoshenko beam: a straight member carrying axial force, shear, bending about
//! two axes and St Venant torsion, with three displacements and three rotations at each node.
//!
//! It shares the truss's geometry (`truss::axis`, the one-Gauss-point line tables) and its
//! Section, and adds a local triad. Local x is the member axis `e1`; local z is a reference
//! vector made perpendicular to the axis — the Body's `orientation` axis from `section.assign`,
//! or by default global Z (global X for a member within 1e-6 of vertical); local y closes the
//! right-handed triad, `y = z × x`. A horizontal beam therefore has the section's `height`
//! (local z, `i_y`) vertical, which is what a floor beam means.
//!
//! Statics are the closed-form shear-flexible element (Przemieniecki): axial `EA/L`, torsion
//! `GJ/L`, and in each bending plane the 4×4 with `Φ = 12 E I / (κ G A L²)`, whose nodal
//! solution is exact for any nodally loaded prismatic member and reproduces
//! `PL³/3EI + PL/κGA` with one element (Benchmark B21). `E` is the material's axial modulus and
//! `G` its Voigt-12 shear modulus, both read from the tangent so the Material Extension Point
//! stays on the path; for the isotropic law they are `E` and `E/2(1+ν)`.
//!
//! The consistent mass is the Hermitian-cubic one without rotary inertia or shear terms, plus
//! `ρ I_p L/6 [[2,1],[1,2]]` in torsion with `I_p = I_y + I_z`. The lumped mass puts `ρAL/2`
//! on every translation, as the truss does, and on the rotations the HRZ diagonal of the
//! *global* consistent rotational block — its diagonal scaled by `420/312`, the transverse
//! HRZ factor — so it is diagonal whatever the member's direction, with a rotational inertia
//! per node whose trace is `(ρ I_p L/3 + 8 ρAL³/420) · 420/312`.
//! A body force integrates to the fixed-end forces `qL/2, ±qL²/12`, which are the same for
//! every `Φ`, and a temperature rise loads the axis exactly as the truss's does.
//!
//! Recovery reports the member's section forces at both ends — `N, V_y, V_z, T, M_y, M_z` in
//! the local frame, positive as the resultant on the far side of a cut — from
//! `f = K_l u_l − f_gravity − f_thermal`, so a member under self-weight reports its true end
//! moments and a restrained heated member its true axial force. The Voigt stress carries the
//! extreme-fibre axial stress `N/A ± |M_z| c_y/I_z ± |M_y| c_z/I_y` of the more heavily bent
//! end, largest magnitude with its sign, so the von Mises the viewer colours is the fibre
//! stress a hand check compares with.
//!
//! Not here: warping torsion, shear-centre offsets (open sections twist under a load through
//! the centroid, and this element does not know), stress stiffening (`geometric` refuses, so a
//! buckling Step on a frame is `unsupported`) and finite strain (`tangent_and_force` refuses).

use femlab_geometry::mesh::ElementKind;

use crate::error::{Error, ErrorCode};
use crate::fem::element::{density, inverted, no_density, omega_max_power, tangent_at_zero, Element, ElementCtx};
use crate::fem::material::VOIGT;
use crate::fem::section::Section;
use crate::fem::shape::{in_reference, rule_of, shape_of};
use crate::fem::truss::{axial_modulus_of, axis, delta_t, midpoint, no_faces, section_of};

/// Degrees of freedom of one member: three displacements and three rotations at two nodes.
pub const N_DOF: usize = 12;

/// How far off its own axis, relative to its half-length, a point may be and still count as
/// being on the member.
const ON_AXIS_TOL: f64 = 1e-8;

/// `|e1 × Z|` below this and the member counts as vertical, so the default reference turns
/// to global X.
const VERTICAL_TOL: f64 = 1e-6;

/// The local triad, rows `[x, y, z]` in global coordinates, and the member's half-length.
pub(crate) struct Frame {
    pub r: [[f64; 3]; 3],
    pub half: f64,
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// The local frame of a member: the axis, then the reference vector (given or by the default
/// rule) made perpendicular to it as local z, and `y = z × x`.
pub(crate) fn frame(c: &ElementCtx<'_>) -> Result<Frame, Error> {
    let (x, half) = axis(c.coords).ok_or_else(inverted)?;
    let reference = match c.orientation {
        Some(v) => v,
        None => {
            let up = [0.0, 0.0, 1.0];
            let off = cross(x, up);
            if libm::sqrt(dot(off, off)) < VERTICAL_TOL {
                [1.0, 0.0, 0.0]
            } else {
                up
            }
        }
    };
    let along = dot(reference, x);
    let mut z = [reference[0] - along * x[0], reference[1] - along * x[1], reference[2] - along * x[2]];
    let norm = libm::sqrt(dot(z, z));
    let scale = libm::sqrt(dot(reference, reference));
    if norm <= VERTICAL_TOL * scale {
        return Err(Error::new(
            ErrorCode::ModelIllPosed,
            format!("the section orientation {reference:?} is parallel to a member, so it fixes no local axes"),
        )
        .at("orientation")
        .suggest("section.assign with an orientation that is not along the member"));
    }
    for v in z.iter_mut() {
        *v /= norm;
    }
    let y = cross(z, x);
    Ok(Frame { r: [x, y, z], half })
}

/// `v_local = R v_global` on every 3-vector of a 12-vector.
pub(crate) fn to_local(r: &[[f64; 3]; 3], v: &[f64], out: &mut [f64]) {
    for b in 0..4 {
        for i in 0..3 {
            out[3 * b + i] = (0..3).map(|j| r[i][j] * v[3 * b + j]).sum();
        }
    }
}

/// `v_global = Rᵀ v_local` on every 3-vector of a 12-vector.
fn to_global(r: &[[f64; 3]; 3], v: &[f64], out: &mut [f64]) {
    for b in 0..4 {
        for i in 0..3 {
            out[3 * b + i] = (0..3).map(|j| r[j][i] * v[3 * b + j]).sum();
        }
    }
}

/// `K_global = Tᵀ K_local T` with `T = diag(R, R, R, R)`, written into `out`.
fn rotate_matrix(r: &[[f64; 3]; 3], local: &[f64], out: &mut [f64]) {
    // One block row/column at a time: (Tᵀ K T)[3a+i][3b+j] = Σ_kl R[k][i] K[3a+k][3b+l] R[l][j].
    for a in 0..4 {
        for b in 0..4 {
            for i in 0..3 {
                for j in 0..3 {
                    let mut s = 0.0;
                    for k in 0..3 {
                        for l in 0..3 {
                            s += r[k][i] * local[(3 * a + k) * N_DOF + 3 * b + l] * r[l][j];
                        }
                    }
                    out[(3 * a + i) * N_DOF + 3 * b + j] = s;
                }
            }
        }
    }
}

/// The moduli and the section together: everything the local matrices are made of. `g` is
/// the shear modulus relating σ₁₂ to the engineering shear strain γ₁₂, the tangent's (3, 3)
/// entry: `E / 2(1 + ν)` for the isotropic law.
struct Props<'a> {
    e: f64,
    g: f64,
    s: &'a Section,
    l: f64,
}

fn props<'a>(c: &ElementCtx<'a>, half: f64) -> Result<Props<'a>, Error> {
    let d = tangent_at_zero(c, 1)?;
    Ok(Props { e: axial_modulus_of(&d), g: d[3 * VOIGT + 3], s: section_of(c)?, l: 2.0 * half })
}

/// Add the 4×4 bending block of one plane into the local 12×12: `dofs` are the local indices
/// of `(w1, θ1, w2, θ2)`, `sign` is `+1` where the rotation is the slope (`θ_z = v'`) and `−1`
/// where it is minus the slope (`θ_y = −w'`), which flips every odd power of `L`.
fn bending_block(k: &mut [f64], dofs: [usize; 4], ei: f64, phi: f64, l: f64, sign: f64) {
    let f = ei / ((1.0 + phi) * l * l * l);
    let (s6l, l2) = (sign * 6.0 * l, l * l);
    let block = [
        [12.0, s6l, -12.0, s6l],
        [s6l, (4.0 + phi) * l2, -s6l, (2.0 - phi) * l2],
        [-12.0, -s6l, 12.0, -s6l],
        [s6l, (2.0 - phi) * l2, -s6l, (4.0 + phi) * l2],
    ];
    for (i, row) in block.iter().enumerate() {
        for (j, v) in row.iter().enumerate() {
            k[dofs[i] * N_DOF + dofs[j]] = f * v;
        }
    }
}

/// The local stiffness: axial, torsion and the two bending planes, zero everywhere else.
fn local_stiffness(p: &Props<'_>, k: &mut [f64]) {
    k.fill(0.0);
    let (s, l) = (p.s, p.l);
    let ea_l = p.e * s.a / l;
    let gj_l = p.g * s.j / l;
    for (i, j, v) in [(0, 0, ea_l), (0, 6, -ea_l), (6, 0, -ea_l), (6, 6, ea_l)] {
        k[i * N_DOF + j] = v;
    }
    for (i, j, v) in [(3, 3, gj_l), (3, 9, -gj_l), (9, 3, -gj_l), (9, 9, gj_l)] {
        k[i * N_DOF + j] = v;
    }
    // Bending in the x–y plane (v, θ_z) bends about z and shears along y.
    let phi_y = 12.0 * p.e * s.i_z / (s.k_y * p.g * s.a * l * l);
    bending_block(k, [1, 5, 7, 11], p.e * s.i_z, phi_y, l, 1.0);
    // Bending in the x–z plane (w, θ_y) bends about y and shears along z.
    let phi_z = 12.0 * p.e * s.i_y / (s.k_z * p.g * s.a * l * l);
    bending_block(k, [2, 4, 8, 10], p.e * s.i_y, phi_z, l, -1.0);
}

/// The transverse HRZ factor: `ρAL` over the two `156/420` diagonal entries of one direction.
const HRZ_SCALE: f64 = 420.0 / 312.0;

/// The consistent local mass.
fn local_mass(rho: f64, s: &Section, l: f64, m: &mut [f64]) {
    m.fill(0.0);
    let ral = rho * s.a * l;
    let ip = rho * (s.i_y + s.i_z) * l;
    for (a, b, v) in [(0, 0, 2.0), (0, 6, 1.0), (6, 0, 1.0), (6, 6, 2.0)] {
        m[a * N_DOF + b] = ral / 6.0 * v;
        m[(a + 3) * N_DOF + b + 3] = ip / 6.0 * v;
    }
    for (dofs, sign) in [([1usize, 5, 7, 11], 1.0), ([2, 4, 8, 10], -1.0)] {
        let sl = sign * l;
        let block = [
            [156.0, 22.0 * sl, 54.0, -13.0 * sl],
            [22.0 * sl, 4.0 * l * l, 13.0 * sl, -3.0 * l * l],
            [54.0, 13.0 * sl, 156.0, -22.0 * sl],
            [-13.0 * sl, -3.0 * l * l, -22.0 * sl, 4.0 * l * l],
        ];
        for (i, row) in block.iter().enumerate() {
            for (j, v) in row.iter().enumerate() {
                m[dofs[i] * N_DOF + dofs[j]] = ral / 420.0 * v;
            }
        }
    }
}

/// The consistent local load of a uniform force per unit length `q` (local components): half
/// of it at each end, and the fixed-end moments `±qL²/12`.
fn local_uniform_load(q: [f64; 3], l: f64, out: &mut [f64]) {
    out.fill(0.0);
    let m = l * l / 12.0;
    for i in 0..3 {
        out[i] = 0.5 * q[i] * l;
        out[6 + i] = 0.5 * q[i] * l;
    }
    // θ_z is the slope, so a +y load hogs the left end up; θ_y is minus the slope.
    out[5] = q[1] * m;
    out[11] = -q[1] * m;
    out[4] = -q[2] * m;
    out[10] = q[2] * m;
}

/// The local thermal load: `EAα ΔT` along the axis, or zero without a temperature field.
fn local_thermal_load(c: &ElementCtx<'_>, p: &Props<'_>, out: &mut [f64]) {
    out.fill(0.0);
    if let Some(dt) = delta_t(c) {
        let f = p.e * p.s.a * c.material.alpha[0] * dt;
        out[0] = -f;
        out[6] = f;
    }
}

/// The member's end forces in the local frame: `K_l u_l` less the loads that act along the
/// member (gravity and temperature), which is what the nodes really push on it with.
fn local_end_forces(c: &ElementCtx<'_>, fr: &Frame, p: &Props<'_>, u: &[f64]) -> [f64; N_DOF] {
    let mut k = [0.0; N_DOF * N_DOF];
    local_stiffness(p, &mut k);
    let mut ul = [0.0; N_DOF];
    to_local(&fr.r, u, &mut ul);
    let mut f = [0.0; N_DOF];
    for i in 0..N_DOF {
        f[i] = (0..N_DOF).map(|j| k[i * N_DOF + j] * ul[j]).sum();
    }
    let mut load = [0.0; N_DOF];
    let rho = c.material.rho;
    let g = [rho * c.gravity[0], rho * c.gravity[1], rho * c.gravity[2]];
    let gl = fr.r.map(|row| p.s.a * dot(row, g));
    local_uniform_load(gl, p.l, &mut load);
    for i in 0..N_DOF {
        f[i] -= load[i];
    }
    local_thermal_load(c, p, &mut load);
    for i in 0..N_DOF {
        f[i] -= load[i];
    }
    f
}

/// Section forces `[N, V_y, V_z, T, M_y, M_z]` at each end of the member, positive as the
/// resultant the far side of a cut exerts on the near side: at end 1 that is minus the nodal
/// force on the element, at end 2 the nodal force itself, so a member in uniform tension
/// reports `N` at both ends and a cantilever's root moment comes out with the sign of its
/// curvature.
pub fn section_forces(c: &ElementCtx<'_>, u: &[f64]) -> Result<[[f64; 6]; 2], Error> {
    let fr = frame(c)?;
    let p = props(c, fr.half)?;
    let f = local_end_forces(c, &fr, &p, u);
    let mut out = [[0.0; 6]; 2];
    for i in 0..6 {
        out[0][i] = -f[i];
        out[1][i] = f[6 + i];
    }
    Ok(out)
}

/// The built-in Timoshenko beam; see the module docs.
pub struct Beam2;

impl Element for Beam2 {
    fn kind(&self) -> ElementKind {
        ElementKind::Beam2
    }
    fn n_dof(&self) -> usize {
        N_DOF
    }
    fn n_gp(&self) -> usize {
        rule_of(ElementKind::Beam2).points.len()
    }

    fn stiffness(&self, c: &ElementCtx<'_>, k: &mut [f64]) -> Result<f64, Error> {
        let fr = frame(c)?;
        let p = props(c, fr.half)?;
        let mut local = [0.0; N_DOF * N_DOF];
        local_stiffness(&p, &mut local);
        rotate_matrix(&fr.r, &local, k);
        Ok(fr.half)
    }

    fn mass(&self, c: &ElementCtx<'_>, m: &mut [f64], lumped: bool) -> Result<(), Error> {
        let fr = frame(c)?;
        let rho = density(c)?;
        let s = section_of(c)?;
        let mut local = [0.0; N_DOF * N_DOF];
        local_mass(rho, s, 2.0 * fr.half, &mut local);
        rotate_matrix(&fr.r, &local, m);
        if lumped {
            let half_mass = 0.5 * rho * s.a * 2.0 * fr.half;
            for i in 0..N_DOF {
                for j in 0..N_DOF {
                    m[i * N_DOF + j] = match (i == j, i % 6 < 3) {
                        (false, _) => 0.0,
                        (true, true) => half_mass,
                        (true, false) => HRZ_SCALE * m[i * N_DOF + i],
                    };
                }
            }
        }
        Ok(())
    }

    fn body_load(&self, c: &ElementCtx<'_>, f: &dyn Fn([f64; 3]) -> [f64; 3], out: &mut [f64]) -> Result<(), Error> {
        let fr = frame(c)?;
        let a = section_of(c)?.a;
        let fv = f(midpoint(c.coords));
        let q = fr.r.map(|row| a * dot(row, fv));
        let mut local = [0.0; N_DOF];
        local_uniform_load(q, 2.0 * fr.half, &mut local);
        to_global(&fr.r, &local, out);
        Ok(())
    }

    fn thermal_load(&self, c: &ElementCtx<'_>, out: &mut [f64]) -> Result<(), Error> {
        out.fill(0.0);
        if delta_t(c).is_none() {
            return Ok(());
        }
        let fr = frame(c)?;
        let p = props(c, fr.half)?;
        let mut local = [0.0; N_DOF];
        local_thermal_load(c, &p, &mut local);
        to_global(&fr.r, &local, out);
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
        let fr = frame(c)?;
        let p = props(c, fr.half)?;
        let f = local_end_forces(c, &fr, &p, u);
        stress.fill(0.0);
        strain.fill(0.0);
        let mut ul = [0.0; N_DOF];
        to_local(&fr.r, u, &mut ul);
        strain[0] = (ul[6] - ul[0]) / p.l;
        // The axial force is the same at both ends; the moments are not, so the fibre stress is
        // taken at the end that bends harder.
        let n = f[6];
        let s = p.s;
        let bending = |mz: f64, my: f64| mz.abs() * s.c_y / s.i_z + my.abs() * s.c_z / s.i_y;
        let extreme = bending(f[5], f[4]).max(bending(f[11], f[10]));
        let (hi, lo) = (n / s.a + extreme, n / s.a - extreme);
        stress[0] = if hi.abs() >= lo.abs() { hi } else { lo };
        Ok(())
    }

    /// Stress stiffening of a frame member is its own piece of work (the 12×12 `N`-dependent
    /// matrix, with the bending–torsion coupling a hand check has to carry); refused by name
    /// rather than approximated with the truss form, which knows nothing about rotations.
    fn geometric(&self, _c: &ElementCtx<'_>, _u: &[f64], _kg: &mut [f64]) -> Result<(), Error> {
        Err(Error::new(
            ErrorCode::Unsupported,
            "a beam has no stress-stiffening matrix yet: frame buckling is not implemented",
        )
        .at("element")
        .suggest("step.add with procedure 'static', or mesh the member as a solid"))
    }

    /// A beam has no finite-strain kernel: the total Lagrangian formulation of #59 is written
    /// for continuum elements, and a corotational beam is its own piece of work.
    fn tangent_and_force(
        &self,
        _c: &ElementCtx<'_>,
        _u: &[f64],
        _state_in: &[f64],
        _out: super::element::TangentOut<'_>,
    ) -> Result<f64, Error> {
        Err(Error::new(ErrorCode::Unsupported, "a line member has no finite-strain kernel")
            .at("element")
            .suggest("step.add with procedure 'static', or mesh the member as a solid"))
    }

    fn gp_xi(&self, i: usize) -> [f64; 3] {
        rule_of(ElementKind::Beam2).points[i]
    }

    fn shape_at(&self, xi: [f64; 3], n: &mut [f64]) {
        shape_of(ElementKind::Beam2, xi, n)
    }

    /// A member is a curve: a point is inside it only if it is on it, exactly as for the truss.
    fn inverse_map(&self, coords: &[f64], x: [f64; 3]) -> Option<[f64; 3]> {
        let (e1, half) = axis(coords)?;
        let mid = midpoint(coords);
        let d = [x[0] - mid[0], x[1] - mid[1], x[2] - mid[2]];
        let along = dot(d, e1);
        let off: f64 = (0..3).map(|i| (d[i] - along * e1[i]) * (d[i] - along * e1[i])).sum();
        if off > (ON_AXIS_TOL * half) * (ON_AXIS_TOL * half) {
            return None;
        }
        let xi = [along / half, 0.0, 0.0];
        in_reference(ElementKind::Beam2, xi, 1e-8).then_some(xi)
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
