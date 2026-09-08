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
