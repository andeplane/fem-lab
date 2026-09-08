//! MITC4 shell kinematics, with global translations and rotations at four nodes.
//!
//! The geometry is `x(r,s,z) = Σ N_i (x_i + z d_i)`, where `z` is a physical
//! thickness coordinate and each `d_i` is a unit director. Rotations move a director
//! by `θ_i × d_i`. Curved and warped surfaces therefore retain their 3D geometry.
//! The two covariant transverse shears are tied at opposite edge midpoints before
//! transformation into an orthonormal material frame. See Ko, Lee and Bathe (2017),
//! §2, equations (1)–(6), https://doi.org/10.1016/j.compstruc.2016.11.004.

use crate::error::{Error, ErrorCode};

pub const N_DOF: usize = 24;
type Vector = [f64; 3];
type Basis = [Vector; 3];
const CORNERS: [[f64; 2]; 4] = [[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]];

fn dot(a: Vector, b: Vector) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: Vector, b: Vector) -> Vector {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn invalid() -> Error {
    Error::new(ErrorCode::MeshInverted, "shell mapping is singular, inverted or non-finite")
        .at("shell geometry")
        .suggest("mesh.set with a finer, consistently oriented surface mesh")
}

// Called only after the relative Jacobian check establishes a finite, nonzero basis.
fn unit(v: Vector) -> Vector {
    let length = libm::sqrt(dot(v, v));
    v.map(|x| x / length)
}

fn shape(r: f64, s: f64) -> ([f64; 4], [[f64; 2]; 4]) {
    let n = CORNERS.map(|[a, b]| 0.25 * (1.0 + a * r) * (1.0 + b * s));
    let dn = CORNERS.map(|[a, b]| [0.25 * a * (1.0 + b * s), 0.25 * b * (1.0 + a * r)]);
    (n, dn)
}

/// Geometry shared by stiffness, mass, loads and recovery. Directors must be unit
/// vectors, point through the positive surface, and be continuous across a smooth patch.
/// At a crease each incident patch keeps its own directors and shares global rotations.
pub struct Surface {
    pub nodes: [Vector; 4],
    pub directors: [Vector; 4],
}

/// Strain-displacement matrix at one thickness point. Rows use engineering Voigt
/// order `xx, yy, zz, xy, xz, yz` in `axes`; the constitutive kernel condenses `σzz`.
pub struct Kinematics {
    pub b: [[f64; N_DOF]; 6],
    /// Orthonormal frame, rows are local axes in global coordinates.
    pub axes: Basis,
    /// Volume Jacobian for integration in `dr ds dz` (z is in metres).
    pub det: f64,
}

impl Surface {
    /// Tangent vectors `g_r, g_s, g_z` at a physical thickness coordinate.
    fn basis(&self, r: f64, s: f64, z: f64) -> Basis {
        let (n, dn) = shape(r, s);
        let mut g = [[0.0; 3]; 3];
        for i in 0..4 {
            for (k, &coordinate) in self.nodes[i].iter().enumerate() {
                // Subtract an origin to avoid losing derivatives to large translations.
                let x = coordinate - self.nodes[0][k] + z * self.directors[i][k];
                g[0][k] += dn[i][0] * x;
                g[1][k] += dn[i][1] * x;
                g[2][k] += n[i] * self.directors[i][k];
            }
        }
        g
    }

    /// Direct covariant tensor-strain matrices (off-diagonal entries are tensor shear).
    fn covariant(&self, r: f64, s: f64, z: f64) -> [[[f64; N_DOF]; 3]; 3] {
        let (n, dn) = shape(r, s);
        let g = self.basis(r, s, z);
        let mut b = [[[0.0; N_DOF]; 3]; 3];
        for node in 0..4 {
            for component in 0..6 {
                let mut axis = [0.0; 3];
                axis[component % 3] = 1.0;
                let v = if component < 3 { axis } else { cross(axis, self.directors[node]) };
                let factors = if component < 3 {
                    [dn[node][0], dn[node][1], 0.0]
                } else {
                    [z * dn[node][0], z * dn[node][1], n[node]]
                };
                for i in 0..3 {
                    for j in 0..3 {
                        b[i][j][6 * node + component] = 0.5 * (dot(g[i], v) * factors[j] + dot(g[j], v) * factors[i]);
                    }
                }
            }
        }
        b
    }

    /// Evaluate the MITC4 assumed strain. Tying is performed on covariant shears,
    /// never on Cartesian components; that distinction matters on skewed surfaces.
    pub fn kinematics(&self, r: f64, s: f64, z: f64) -> Result<Kinematics, Error> {
        let g = self.basis(r, s, z);
        let normal = cross(g[0], g[1]);
        let det = dot(normal, g[2]);
        let scale = libm::sqrt(dot(g[0], g[0]) * dot(g[1], g[1]) * dot(g[2], g[2]));
        if !det.is_finite() || det <= 1e-12 * scale {
            return Err(invalid());
        }
        let e1 = unit(g[0]);
        let e3 = unit(normal);
        let axes = [e1, cross(e3, e1), e3];
        let dual = [cross(g[1], g[2]), cross(g[2], g[0]), normal].map(|v| v.map(|x| x / det));
        let mut cov = self.covariant(r, s, z);
        for (direction, coordinate) in [(0, s), (1, r)] {
            let (lo, hi) = if direction == 0 {
                (self.covariant(0.0, -1.0, z), self.covariant(0.0, 1.0, z))
            } else {
                (self.covariant(-1.0, 0.0, z), self.covariant(1.0, 0.0, z))
            };
            for dof in 0..N_DOF {
                let tied =
                    0.5 * ((1.0 - coordinate) * lo[direction][2][dof] + (1.0 + coordinate) * hi[direction][2][dof]);
                cov[direction][2][dof] = tied;
                cov[2][direction][dof] = tied;
            }
        }
        let transform = axes.map(|e| dual.map(|v| dot(e, v)));
        let mut b = [[0.0; N_DOF]; 6];
        for (row, (i, j)) in [(0, 0), (1, 1), (2, 2), (0, 1), (0, 2), (1, 2)].into_iter().enumerate() {
            let engineering = if i == j { 1.0 } else { 2.0 };
            for a in 0..3 {
                for c in 0..3 {
                    let factor = engineering * transform[i][a] * transform[j][c];
                    for dof in 0..N_DOF {
                        b[row][dof] += factor * cov[a][c][dof];
                    }
                }
            }
        }
        Ok(Kinematics { b, axes, det })
    }
}

use crate::fem::element::{
    density, no_density, omega_max_power, tangent_at_zero, Element, ElementCtx, FaceLoad, TangentOut,
};
use crate::fem::material::{transpose3, voigt_rotation};
use crate::fem::quadrature::QUAD_2X2;
use femlab_geometry::mesh::ElementKind;

/// Dimensionless penalty for the difference between drilling rotation and surface spin.
/// It vanishes for rigid motion and constant membrane/bending patch fields (ADR 0023).
const DRILL: f64 = 1e-3;
const SHEAR: f64 = 5.0 / 6.0;

fn thickness(c: &ElementCtx<'_>) -> Result<f64, Error> {
    let t = c.section.and_then(|s| s.thickness).ok_or_else(|| {
        Error::new(ErrorCode::ModelNoSection, "a shell needs a thickness section")
            .at("section")
            .suggest("section.add with shape kind 'shell', then section.assign")
    })?;
    if !t.is_finite() || t <= 0.0 {
        return Err(Error::schema("shell thickness must be positive and finite")
            .at("section.thickness")
            .suggest("section.add with a positive thickness"));
    }
    Ok(t)
}

fn surface(c: &ElementCtx<'_>) -> Result<Surface, Error> {
    if c.idealisation.dim() != 3 {
        return Err(Error::new(ErrorCode::Unsupported, "shells require the 3D idealisation")
            .at("idealisation")
            .suggest("model.setIdealisation with kind solid3d"));
    }
    if c.coords.len() != 12 {
        return Err(invalid());
    }
    let nodes = std::array::from_fn(|i| [c.coords[3 * i], c.coords[3 * i + 1], c.coords[3 * i + 2]]);
    let directors = match c.directors {
        Some(d) => d,
        None => {
            // Isolated-element callers may omit directors. Each corner gets its own
            // isoparametric normal; assembled smooth patches supply shared directors.
            let seed = Surface { nodes, directors: [[0.0, 0.0, 1.0]; 4] };
            let mut d = [[0.0; 3]; 4];
            for (i, [r, s]) in CORNERS.into_iter().enumerate() {
                let g = seed.basis(r, s, 0.0);
                let n = cross(g[0], g[1]);
                let length = libm::sqrt(dot(n, n));
                if !length.is_finite() || length <= 0.0 {
                    return Err(invalid());
                }
                d[i] = n.map(|x| x / length);
            }
            d
        }
    };
    for d in directors {
        if (dot(d, d) - 1.0).abs() > 1e-10 || !dot(d, d).is_finite() {
            return Err(invalid());
        }
    }
    Ok(Surface { nodes, directors })
}

/// Local plane-stress tangent, retaining transverse shear. Global material orientations
/// are resolved by the MaterialLaw path, then transformed to this shell point's frame.
fn local_tangent(global: &[f64], axes: &Basis) -> [[f64; 6]; 6] {
    let rotation = voigt_rotation(&transpose3(axes));
    let mut d = [[0.0; 6]; 6];
    for i in 0..6 {
        for j in 0..6 {
            for a in 0..6 {
                for b in 0..6 {
                    d[i][j] += rotation[a][i] * global[a * 6 + b] * rotation[b][j];
                }
            }
        }
    }
    let mut condensed = [[0.0; 6]; 6];
    for i in [0, 1, 3, 4, 5] {
        for j in [0, 1, 3, 4, 5] {
            let correction =
                if i >= 4 { libm::sqrt(SHEAR) } else { 1.0 } * if j >= 4 { libm::sqrt(SHEAR) } else { 1.0 };
            condensed[i][j] = correction * (d[i][j] - d[i][2] * d[2][j] / d[2][2]);
        }
    }
    condensed
}

impl Surface {
    fn displacement_shape(&self, r: f64, s: f64, z: f64) -> [[f64; N_DOF]; 3] {
        let (n, _) = shape(r, s);
        let mut h = [[0.0; N_DOF]; 3];
        for node in 0..4 {
            for component in 0..3 {
                h[component][6 * node + component] = n[node];
                let mut axis = [0.0; 3];
                axis[component] = 1.0;
                let rotation = cross(axis, self.directors[node]);
                for k in 0..3 {
                    h[k][6 * node + 3 + component] = z * n[node] * rotation[k];
                }
            }
        }
        h
    }

    fn position(&self, r: f64, s: f64, z: f64) -> Vector {
        let (n, _) = shape(r, s);
        std::array::from_fn(|k| (0..4).map(|i| n[i] * (self.nodes[i][k] + z * self.directors[i][k])).sum())
    }

    fn drilling(&self, r: f64, s: f64, kin: &Kinematics) -> [f64; N_DOF] {
        let (n, dn) = shape(r, s);
        let g = self.basis(r, s, 0.0);
        let normal = kin.axes[2];
        let area = dot(cross(g[0], g[1]), normal);
        let dual = [cross(g[1], normal).map(|x| x / area), cross(normal, g[0]).map(|x| x / area)];
        let mut b = [0.0; N_DOF];
        for i in 0..4 {
            let grad: Vector = std::array::from_fn(|k| dn[i][0] * dual[0][k] + dn[i][1] * dual[1][k]);
            let dx = dot(grad, kin.axes[0]);
            let dy = dot(grad, kin.axes[1]);
            for k in 0..3 {
                b[6 * i + k] = 0.5 * (dy * kin.axes[0][k] - dx * kin.axes[1][k]);
                b[6 * i + 3 + k] = n[i] * normal[k];
            }
        }
        b
    }
}

/// MITC4 shell through the standard Element Extension Point. Eight thickness points
/// (2×2×2) for integration; four midsurface points for ordinary stress recovery.
pub struct Shell4;

impl Element for Shell4 {
    fn kind(&self) -> ElementKind {
        ElementKind::Shell4
    }
    fn n_dof(&self) -> usize {
        N_DOF
    }
    fn n_gp(&self) -> usize {
        4
    }

    fn stiffness(&self, c: &ElementCtx<'_>, out: &mut [f64]) -> Result<f64, Error> {
        let surface = surface(c)?;
        let t = thickness(c)?;
        let global = tangent_at_zero(c, 1)?;
        out.fill(0.0);
        let mut min_det = f64::INFINITY;
        for [r, s, _] in QUAD_2X2.points {
            let middle = surface.kinematics(*r, *s, 0.0)?;
            for z in [-t / libm::sqrt(12.0), t / libm::sqrt(12.0)] {
                let kin = surface.kinematics(*r, *s, z)?;
                min_det = min_det.min(kin.det);
                let d = local_tangent(&global, &kin.axes);
                let mut db = [[0.0; N_DOF]; 6];
                for (a, db_row) in db.iter_mut().enumerate() {
                    for (b, value) in d[a].iter().enumerate() {
                        for (entry, strain) in db_row.iter_mut().zip(kin.b[b]) {
                            *entry += value * strain;
                        }
                    }
                }
                for i in 0..N_DOF {
                    for j in 0..N_DOF {
                        out[i * N_DOF + j] += 0.5 * t * kin.det * (0..6).map(|a| kin.b[a][i] * db[a][j]).sum::<f64>();
                    }
                }
            }
            let kin = middle;
            let b = surface.drilling(*r, *s, &kin);
            let d = local_tangent(&global, &kin.axes);
            for i in 0..N_DOF {
                for j in 0..N_DOF {
                    out[i * N_DOF + j] += DRILL * d[3][3] * t * kin.det * b[i] * b[j];
                }
            }
        }
        Ok(min_det)
    }

    fn mass(&self, c: &ElementCtx<'_>, out: &mut [f64], lumped: bool) -> Result<(), Error> {
        let surface = surface(c)?;
        let (t, rho) = (thickness(c)?, density(c)?);
        out.fill(0.0);
        for [r, s, _] in QUAD_2X2.points {
            let (n, _) = shape(*r, *s);
            for z in [-t / libm::sqrt(12.0), t / libm::sqrt(12.0)] {
                let kin = surface.kinematics(*r, *s, z)?;
                let h = surface.displacement_shape(*r, *s, z);
                let weight = 0.5 * t * rho * kin.det;
                for i in 0..N_DOF {
                    for j in 0..N_DOF {
                        out[i * N_DOF + j] += weight * (0..3).map(|a| h[a][i] * h[a][j]).sum::<f64>();
                        if i % 6 >= 3 && j % 6 >= 3 {
                            out[i * N_DOF + j] += weight
                                * DRILL
                                * z
                                * z
                                * n[i / 6]
                                * n[j / 6]
                                * surface.directors[i / 6][i % 6 - 3]
                                * surface.directors[j / 6][j % 6 - 3];
                        }
                    }
                }
            }
        }
        if lumped {
            // HRZ per global component: preserve its consistent rigid-velocity inertia.
            let mut diagonal = [0.0; N_DOF];
            for component in 0..6 {
                let mut total = 0.0;
                let mut trace = 0.0;
                for i in 0..4 {
                    trace += out[(6 * i + component) * N_DOF + 6 * i + component];
                    for j in 0..4 {
                        total += out[(6 * i + component) * N_DOF + 6 * j + component];
                    }
                }
                let scale = if trace > 0.0 { total / trace } else { 0.0 };
                for i in 0..4 {
                    diagonal[6 * i + component] = scale * out[(6 * i + component) * N_DOF + 6 * i + component];
                }
            }
            out.fill(0.0);
            for i in 0..N_DOF {
                out[i * N_DOF + i] = diagonal[i];
            }
        }
        Ok(())
    }

    fn body_load(&self, c: &ElementCtx<'_>, f: &dyn Fn(Vector) -> Vector, out: &mut [f64]) -> Result<(), Error> {
        let surface = surface(c)?;
        let t = thickness(c)?;
        out.fill(0.0);
        for [r, s, _] in QUAD_2X2.points {
            for z in [-t / libm::sqrt(12.0), t / libm::sqrt(12.0)] {
                let kin = surface.kinematics(*r, *s, z)?;
                let h = surface.displacement_shape(*r, *s, z);
                let force = f(surface.position(*r, *s, z));
                for (i, value) in out.iter_mut().enumerate() {
                    *value += 0.5 * t * kin.det * (0..3).map(|a| h[a][i] * force[a]).sum::<f64>();
                }
            }
        }
        Ok(())
    }

    fn face_load(&self, c: &ElementCtx<'_>, local_face: u8, load: FaceLoad, out: &mut [f64]) -> Result<(), Error> {
        let surface = surface(c)?;
        if local_face > 1 {
            return Err(Error::schema("a shell has bottom (0) and top (1) faces")
                .at("face")
                .suggest("load.pressure or load.traction on a shell top or bottom face Set"));
        }
        let sign = if local_face == 0 { -1.0 } else { 1.0 };
        let z = 0.5 * sign * thickness(c)?;
        out.fill(0.0);
        for [r, s, _] in QUAD_2X2.points {
            let kin = surface.kinematics(*r, *s, z)?;
            let g = surface.basis(*r, *s, z);
            let normal = cross(g[0], g[1]);
            let area = libm::sqrt(dot(normal, normal));
            let force = match load {
                FaceLoad::Pressure(p) => kin.axes[2].map(|n| -sign * p * n),
                FaceLoad::Traction(t) => t,
                FaceLoad::Torque(_) => return Err(unsupported("axisymmetric torque")),
            };
            let h = surface.displacement_shape(*r, *s, z);
            for (i, value) in out.iter_mut().enumerate() {
                *value += area * (0..3).map(|a| h[a][i] * force[a]).sum::<f64>();
            }
        }
        Ok(())
    }

    fn thermal_load(&self, c: &ElementCtx<'_>, out: &mut [f64]) -> Result<(), Error> {
        out.fill(0.0);
        let Some(temperature) = c.temperature else {
            return Ok(());
        };
        let surface = surface(c)?;
        let t = thickness(c)?;
        let global = tangent_at_zero(c, 1)?;
        for [r, s, _] in QUAD_2X2.points {
            let (n, _) = shape(*r, *s);
            let delta = (0..4).map(|i| n[i] * temperature[i]).sum::<f64>() - c.t_ref;
            for z in [-t / libm::sqrt(12.0), t / libm::sqrt(12.0)] {
                let kin = surface.kinematics(*r, *s, z)?;
                let d = local_tangent(&global, &kin.axes);
                let alpha = local_alpha(c, &kin.axes);
                for (i, value) in out.iter_mut().enumerate() {
                    for (a, row) in d.iter().enumerate() {
                        for (entry, expansion) in row.iter().zip(alpha) {
                            *value += 0.5 * t * kin.det * kin.b[a][i] * entry * expansion * delta;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn recover(&self, c: &ElementCtx<'_>, u: &[f64], stress: &mut [f64], strain: &mut [f64]) -> Result<(), Error> {
        recover_at(c, u, 0.0, stress, strain)
    }

    fn geometric(&self, _c: &ElementCtx<'_>, _u: &[f64], _kg: &mut [f64]) -> Result<(), Error> {
        Err(unsupported("stress stiffening"))
    }
    fn tangent_and_force(
        &self,
        _c: &ElementCtx<'_>,
        _u: &[f64],
        _state: &[f64],
        _out: TangentOut<'_>,
    ) -> Result<f64, Error> {
        Err(unsupported("finite strain"))
    }
    fn gp_xi(&self, i: usize) -> Vector {
        QUAD_2X2.points[i]
    }
    fn shape_at(&self, xi: Vector, n: &mut [f64]) {
        n.copy_from_slice(&shape(xi[0], xi[1]).0);
    }

    fn inverse_map(&self, coords: &[f64], x: Vector) -> Option<Vector> {
        inverse_surface(coords, x)
    }
    fn omega_max(&self, c: &ElementCtx<'_>) -> Result<f64, Error> {
        let mut k = [0.0; N_DOF * N_DOF];
        let mut m = [0.0; N_DOF * N_DOF];
        self.stiffness(c, &mut k)?;
        self.mass(c, &mut m, true)?;
        if c.material.rho == 0.0 {
            return Err(no_density());
        }
        Ok(omega_max_power(&k, &m, N_DOF))
    }
}

fn unsupported(capability: &str) -> Error {
    Error::new(ErrorCode::Unsupported, format!("MITC4 shells do not yet support {capability}"))
        .at("element")
        .suggest("step.add with procedure 'static', or mesh the body as a solid")
}

fn local_alpha(c: &ElementCtx<'_>, axes: &Basis) -> [f64; 6] {
    let material_axes = c.material.axes.unwrap_or([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);
    let alpha = crate::fem::material::rotate_diagonal(&material_axes, c.material.alpha);
    let mut local = [0.0; 6];
    for (row, (i, j)) in [(0, 0), (1, 1), (2, 2), (0, 1), (0, 2), (1, 2)].into_iter().enumerate() {
        for (a, tensor_row) in alpha.iter().enumerate() {
            for (b, value) in tensor_row.iter().enumerate() {
                local[row] += axes[i][a] * value * axes[j][b];
            }
        }
        if i != j {
            local[row] *= 2.0;
        }
    }
    local
}

/// Four point stress recovery at a physical offset from the midsurface. Stress and
/// total strain use global Voigt axes, so top/bottom fields compose with solid fields.
/// The thickness-normal stress is zero; the total normal strain follows plane stress.
pub fn recover_at(c: &ElementCtx<'_>, u: &[f64], z: f64, stress: &mut [f64], strain: &mut [f64]) -> Result<(), Error> {
    let surface = surface(c)?;
    let global = tangent_at_zero(c, 1)?;
    for (gp, [r, s, _]) in QUAD_2X2.points.iter().enumerate() {
        let kin = surface.kinematics(*r, *s, z)?;
        let d = local_tangent(&global, &kin.axes);
        let mut eps = kin.b.map(|row| row.iter().zip(u).map(|(b, v)| b * v).sum::<f64>());
        let (n, _) = shape(*r, *s);
        let delta = c.temperature.map_or(0.0, |temp| (0..4).map(|i| n[i] * temp[i]).sum::<f64>() - c.t_ref);
        let alpha = local_alpha(c, &kin.axes);
        let elastic: [f64; 6] = std::array::from_fn(|a| eps[a] - alpha[a] * delta);
        let sig: [f64; 6] = d.map(|row| row.iter().zip(elastic).map(|(a, e)| a * e).sum());
        // Recover the eliminated normal strain from the full rotated elastic tangent.
        let to_global = voigt_rotation(&transpose3(&kin.axes));
        let mut normal_row = [0.0; 6];
        for (j, entry) in normal_row.iter_mut().enumerate() {
            for a in 0..6 {
                for b in 0..6 {
                    *entry += to_global[a][2] * global[a * 6 + b] * to_global[b][j];
                }
            }
        }
        eps[2] = alpha[2] * delta
            - [0, 1, 3, 4, 5].into_iter().map(|j| normal_row[j] * elastic[j]).sum::<f64>() / normal_row[2];
        let to_local = voigt_rotation(&kin.axes);
        for i in 0..6 {
            strain[6 * gp + i] = (0..6).map(|j| to_global[i][j] * eps[j]).sum();
            stress[6 * gp + i] = (0..6).map(|j| to_local[j][i] * sig[j]).sum();
        }
    }
    Ok(())
}

fn inverse_surface(coords: &[f64], x: Vector) -> Option<Vector> {
    if coords.len() != 12 {
        return None;
    }
    let nodes = std::array::from_fn(|i| [coords[3 * i], coords[3 * i + 1], coords[3 * i + 2]]);
    let surface = Surface { nodes, directors: [[0.0, 0.0, 1.0]; 4] };
    let mut xi = [0.0; 3];
    for _ in 0..20 {
        let at = surface.position(xi[0], xi[1], 0.0);
        let residual = [x[0] - at[0], x[1] - at[1], x[2] - at[2]];
        let g = surface.basis(xi[0], xi[1], 0.0);
        let (a, b, d) = (dot(g[0], g[0]), dot(g[0], g[1]), dot(g[1], g[1]));
        let det = a * d - b * b;
        if !det.is_finite() || det <= 1e-14 * a * d {
            return None;
        }
        let tol = 1e-9 * libm::sqrt(a + d);
        if libm::sqrt(dot(residual, residual)) <= tol {
            return (xi[0].abs() <= 1.0 + 1e-9 && xi[1].abs() <= 1.0 + 1e-9).then_some(xi);
        }
        let (f0, f1) = (dot(g[0], residual), dot(g[1], residual));
        xi[0] += (d * f0 - b * f1) / det;
        xi[1] += (a * f1 - b * f0) / det;
    }
    None
}

/// Coordinate-only shell Jacobian check, used before material and section resolution.
/// Unlike a planar quad check, this accepts surfaces in any spatial orientation.
pub fn min_surface_jacobian(coords: &[f64]) -> Option<f64> {
    if coords.len() != 12 {
        return None;
    }
    let nodes = std::array::from_fn(|i| [coords[3 * i], coords[3 * i + 1], coords[3 * i + 2]]);
    let surface = Surface { nodes, directors: [[0.0, 0.0, 1.0]; 4] };
    let centre = surface.basis(0.0, 0.0, 0.0);
    let normal = cross(centre[0], centre[1]);
    let length = libm::sqrt(dot(normal, normal));
    if !length.is_finite() || length <= 0.0 {
        return None;
    }
    let mut minimum = f64::INFINITY;
    for [r, s] in CORNERS.into_iter().chain(QUAD_2X2.points.iter().map(|p| [p[0], p[1]])) {
        let g = surface.basis(r, s, 0.0);
        let det = dot(cross(g[0], g[1]), normal) / length;
        if !det.is_finite() || det <= 1e-12 * length {
            return None;
        }
        minimum = minimum.min(det);
    }
    Some(minimum)
}
