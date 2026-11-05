//! Objective, elastic corotational Timoshenko beam (ADR 0048).
//!
//! A scalar energy supplies both force and its exact Hessian. Total nodal rotations are
//! exponential coordinates in the global frame; no finite-difference tangent or history
//! dependent rotation update is used. The constitutive strains remain small.
use super::*;
use std::ops::{Add, Div, Mul, Neg, Sub};

/// Second-order forward differentiation with respect to this element's twelve coordinates.
/// The fixed size keeps reduction order independent of workers and avoids a second kernel.
#[derive(Clone, Copy)]
struct Jet {
    v: f64,
    d: [f64; N_DOF],
    h: [[f64; N_DOF]; N_DOF],
}
impl Jet {
    fn constant(v: f64) -> Self {
        Self { v, d: [0.0; N_DOF], h: [[0.0; N_DOF]; N_DOF] }
    }
    fn variable(v: f64, i: usize) -> Self {
        let mut a = Self::constant(v);
        a.d[i] = 1.0;
        a
    }
    fn unary(self, v: f64, first: f64, second: f64) -> Self {
        let mut a = Self::constant(v);
        for i in 0..N_DOF {
            a.d[i] = first * self.d[i];
            for j in 0..N_DOF {
                a.h[i][j] = first * self.h[i][j] + second * self.d[i] * self.d[j];
            }
        }
        a
    }
    fn sqrt(self) -> Self {
        let v = libm::sqrt(self.v);
        self.unary(v, 0.5 / v, -0.25 / (v * v * v))
    }
    fn sin(self) -> Self {
        self.unary(libm::sin(self.v), libm::cos(self.v), -libm::sin(self.v))
    }
    fn cos(self) -> Self {
        self.unary(libm::cos(self.v), -libm::sin(self.v), -libm::cos(self.v))
    }
    fn acos(self) -> Self {
        let s = libm::sqrt(1.0 - self.v * self.v);
        self.unary(libm::acos(self.v), -1.0 / s, -self.v / (s * s * s))
    }
    fn reciprocal(self) -> Self {
        self.unary(1.0 / self.v, -1.0 / (self.v * self.v), 2.0 / (self.v * self.v * self.v))
    }
}
impl Add for Jet {
    type Output = Self;
    fn add(self, b: Self) -> Self {
        let mut a = Self::constant(self.v + b.v);
        for i in 0..N_DOF {
            a.d[i] = self.d[i] + b.d[i];
            for j in 0..N_DOF {
                a.h[i][j] = self.h[i][j] + b.h[i][j];
            }
        }
        a
    }
}
impl Neg for Jet {
    type Output = Self;
    fn neg(self) -> Self {
        self.unary(-self.v, -1.0, 0.0)
    }
}
impl Sub for Jet {
    type Output = Self;
    fn sub(self, b: Self) -> Self {
        let mut a = Self::constant(self.v - b.v);
        for i in 0..N_DOF {
            a.d[i] = self.d[i] - b.d[i];
            for j in 0..N_DOF {
                a.h[i][j] = self.h[i][j] - b.h[i][j];
            }
        }
        a
    }
}
// Product-rule derivatives necessarily add terms inside multiplication.
#[allow(clippy::suspicious_arithmetic_impl)]
impl Mul for Jet {
    type Output = Self;
    fn mul(self, b: Self) -> Self {
        let mut a = Self::constant(self.v * b.v);
        for i in 0..N_DOF {
            a.d[i] = self.d[i] * b.v + self.v * b.d[i];
            for j in 0..N_DOF {
                a.h[i][j] = self.h[i][j] * b.v + self.d[i] * b.d[j] + self.d[j] * b.d[i] + self.v * b.h[i][j];
            }
        }
        a
    }
}
// Differentiated division is multiplication by the differentiated reciprocal.
#[allow(clippy::suspicious_arithmetic_impl)]
impl Div for Jet {
    type Output = Self;
    fn div(self, b: Self) -> Self {
        self * b.reciprocal()
    }
}
fn c(v: f64) -> Jet {
    Jet::constant(v)
}
type V = [Jet; 3];
type M = [[Jet; 3]; 3];
fn dotj(a: V, b: V) -> Jet {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn crossj(a: V, b: V) -> V {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn normalize(a: V) -> Result<V, Error> {
    let n2 = dotj(a, a);
    if !n2.v.is_finite() || n2.v < 1e-24 {
        return Err(singular());
    }
    let n = n2.sqrt();
    Ok(a.map(|x| x / n))
}
fn singular() -> Error {
    Error::new(
        ErrorCode::MeshInverted,
        "the corotational beam frame is singular (collapsed chord or opposed section directors)",
    )
    .at("element")
    .suggest("step.add with smaller load increments, or mesh.set with more beam elements")
}
/// Rodrigues exponential with analytic Taylor limits, including its first two derivatives.
fn exp(r: V) -> M {
    let t = dotj(r, r);
    let (a, b) = if t.v < 1e-8 {
        (
            c(1.0) - t * c(1.0 / 6.0) + t * t * c(1.0 / 120.0) - t * t * t * c(1.0 / 5040.0),
            c(0.5) - t * c(1.0 / 24.0) + t * t * c(1.0 / 720.0) - t * t * t * c(1.0 / 40320.0),
        )
    } else {
        let angle = t.sqrt();
        (angle.sin() / angle, (c(1.0) - angle.cos()) / t)
    };
    let s = [[c(0.0), -r[2], r[1]], [r[2], c(0.0), -r[0]], [-r[1], r[0], c(0.0)]];
    let mut out = [[c(0.0); 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] =
                c(f64::from(u8::from(i == j))) + a * s[i][j] + b * (r[i] * r[j] - c(f64::from(u8::from(i == j))) * t);
        }
    }
    out
}
/// Principal logarithm, used only for the small *relative* section rotations. The absolute
/// nodal rotations can be large. The pi branch is refused rather than choosing an axis.
fn log(r: M) -> Result<V, Error> {
    let cosine = (r[0][0] + r[1][1] + r[2][2] - c(1.0)) * c(0.5);
    if cosine.v <= -1.0 + 1e-8 {
        return Err(singular());
    }
    let factor = if cosine.v > 1.0 - 1e-6 {
        let t = c(1.0) - cosine;
        c(1.0) + t * c(1.0 / 3.0) + t * t * c(2.0 / 15.0) + t * t * t * c(2.0 / 35.0)
    } else {
        cosine.acos() / (c(1.0) - cosine * cosine).sqrt()
    };
    Ok([
        (r[2][1] - r[1][2]) * c(0.5) * factor,
        (r[0][2] - r[2][0]) * c(0.5) * factor,
        (r[1][0] - r[0][1]) * c(0.5) * factor,
    ])
}

fn deformation(cxt: &ElementCtx<'_>, u: &[f64], fr: &Frame) -> Result<[Jet; N_DOF], Error> {
    let mut v = [c(0.0); N_DOF];
    for i in 0..N_DOF {
        v[i] = Jet::variable(u[i], i);
    }
    let chord = [
        c(cxt.coords[3] - cxt.coords[0]) + v[6] - v[0],
        c(cxt.coords[4] - cxt.coords[1]) + v[7] - v[1],
        c(cxt.coords[5] - cxt.coords[2]) + v[8] - v[2],
    ];
    let x = normalize(chord)?;
    for node in 0..2 {
        let r2: f64 = u[node * 6 + 3..node * 6 + 6].iter().map(|r| r * r).sum();
        if !r2.is_finite() || r2 >= std::f64::consts::PI * std::f64::consts::PI {
            return Err(Error::new(
                ErrorCode::Unsupported,
                "corotational beam total rotation vectors must have magnitude less than pi radians",
            )
            .at("rotation")
            .suggest("reduce the final applied moment or model larger rotations with solid elements"));
        }
    }
    let rotations = [exp([v[3], v[4], v[5]]), exp([v[9], v[10], v[11]])];
    let mut sections = [[[c(0.0); 3]; 3]; 2];
    for node in 0..2 {
        for axis in 0..3 {
            for global in 0..3 {
                for k in 0..3 {
                    sections[node][axis][global] =
                        sections[node][axis][global] + rotations[node][global][k] * c(fr.r[axis][k]);
                }
            }
        }
    }
    let director = [
        sections[0][2][0] + sections[1][2][0],
        sections[0][2][1] + sections[1][2][1],
        sections[0][2][2] + sections[1][2][2],
    ];
    let along = dotj(x, director);
    let z = normalize([director[0] - along * x[0], director[1] - along * x[1], director[2] - along * x[2]])?;
    let axes = [x, crossj(z, x), z];
    let mut q = [c(0.0); N_DOF];
    q[6] = dotj(chord, chord).sqrt() - c(2.0 * fr.half);
    for node in 0..2 {
        let mut relative = [[c(0.0); 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                relative[i][j] = dotj(axes[i], sections[node][j]);
            }
        }
        let r = log(relative)?;
        q[6 * node + 3..6 * node + 6].copy_from_slice(&r);
    }
    Ok(q)
}

pub(super) fn tangent(
    cxt: &ElementCtx<'_>,
    u: &[f64],
    out: super::super::element::TangentOut<'_>,
) -> Result<f64, Error> {
    // A tangent at zero is an elastic section law, not a plasticity algorithm. Never discard
    // history supplied by a constitutive plugin and claim an elastic calculation as plastic.
    if cxt.material.law.n_state() != 0 {
        return Err(Error::new(
            ErrorCode::Unsupported,
            "corotational beams support elastic section laws, not stateful plastic materials",
        )
        .at("material")
        .suggest("material.add with an elastic law, or mesh the member as a solid"));
    }
    let fr = frame(cxt)?;
    let p = props(cxt, fr.half)?;
    let mut q = deformation(cxt, u, &fr)?;
    let total_axial = q[6].v / p.l;
    q[6] = q[6] - c(p.l * cxt.material.alpha[0] * delta_t(cxt).unwrap_or(0.0));
    let mut k = [0.0; N_DOF * N_DOF];
    local_stiffness(&p, &mut k);
    let mut energy = c(0.0);
    let mut local = [0.0; N_DOF];
    for i in 0..N_DOF {
        for j in 0..N_DOF {
            if k[i * N_DOF + j] != 0.0 {
                energy = energy + q[i] * q[j] * c(0.5 * k[i * N_DOF + j]);
            }
            local[i] += k[i * N_DOF + j] * q[j].v;
        }
    }
    out.f.copy_from_slice(&energy.d);
    for i in 0..N_DOF {
        out.k[i * N_DOF..(i + 1) * N_DOF].copy_from_slice(&energy.h[i]);
    }
    out.stress.fill(0.0);
    out.strain.fill(0.0);
    out.strain[0] = total_axial;
    let extreme = (local[5].abs() * p.s.c_y / p.s.i_z + local[4].abs() * p.s.c_z / p.s.i_y)
        .max(local[11].abs() * p.s.c_y / p.s.i_z + local[10].abs() * p.s.c_z / p.s.i_y);
    let (hi, lo) = (local[6] / p.s.a + extreme, local[6] / p.s.a - extreme);
    out.stress[0] = if hi.abs() >= lo.abs() { hi } else { lo };
    Ok(fr.half)
}
