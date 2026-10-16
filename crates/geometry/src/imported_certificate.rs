//! Conservative certificates for original linear and quadratic solid geometry (#517, #655).
//!
//! Finite f64 coordinates become exact rationals. Complete Abaqus interpolation
//! maps retain their curved faces; no corner-only or triangulated proxy is accepted.
//! Acceptance proves global injectivity and every candidate pair's labelled
//! contact. Some valid cells cannot satisfy these sufficient conditions: bounded
//! proof failure is `Inconclusive`, not a claim that their geometry is invalid.

use manifold_rust::linalg::Vec3;
use manifold_rust::robust::exact::backend::{rat_is_zero, rat_new, rat_one, rat_zero, Int, Rational};
use manifold_rust::robust::exact::predicates::orient3d_r;
use manifold_rust::robust::exact::rational::R3;
use manifold_rust::robust::exact::Sign;

use crate::{ElementKind, Mesh};

const HEX_BITS: [[usize; 3]; 8] =
    [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const MAX_DEPTH: usize = 12;
const MAX_BOXES: usize = 4096;

/// Dense element IDs allow an importing caller to attach the original source labels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportedCertificateError {
    /// An exact witness establishes invalidity, independently of proof limits.
    Invalid { elements: Vec<u32>, cause: String },
    /// The sufficient certificate or its deterministic work budget was exhausted.
    Inconclusive { elements: Vec<u32>, cause: String },
}

fn fraction(numerator: usize, denominator: usize) -> Rational {
    rat_new(Int::from(numerator), Int::from(denominator))
}

fn count(degree: [usize; 3]) -> usize {
    degree.iter().map(|n| n + 1).product()
}

fn index(degree: [usize; 3], e: [usize; 3]) -> usize {
    e[0] + (degree[0] + 1) * (e[1] + (degree[1] + 1) * e[2])
}

fn exponents(degree: [usize; 3], i: usize) -> [usize; 3] {
    [i % (degree[0] + 1), i / (degree[0] + 1) % (degree[1] + 1), i / ((degree[0] + 1) * (degree[1] + 1))]
}

fn choose(n: usize, k: usize) -> usize {
    (0..k).fold(1, |value, i| value * (n - i) / (i + 1))
}

/// Small tensor power polynomials. A face quadric composed with a trilinear
/// map retains its full degree two in every reference coordinate.
#[derive(Clone)]
struct Polynomial {
    degree: [usize; 3],
    coefficients: Vec<Rational>,
}

impl Polynomial {
    fn coordinate(axis: usize) -> Self {
        let mut degree = [0; 3];
        degree[axis] = 1;
        let mut result = Self::zero(degree);
        result.coefficients[1] = rat_one();
        result
    }

    fn compose(&self, map: &[Self; 3]) -> Self {
        let mut result = Self::constant(rat_zero());
        for (i, coefficient) in self.coefficients.iter().enumerate() {
            if rat_is_zero(coefficient) {
                continue;
            }
            let mut term = Self::constant(coefficient.clone());
            for (axis, power) in exponents(self.degree, i).into_iter().enumerate() {
                for _ in 0..power {
                    term = term.mul(&map[axis]);
                }
            }
            result = result.add(&term);
        }
        result
    }

    // The simplex is the image of the closed cube under r=u,s=(1-u)v,
    // t=(1-u)(1-v)w. Positivity of this exact composition is sufficient everywhere
    // in the tetrahedron, including its collapsed reference boundaries.
    fn on_simplex(&self) -> Self {
        let one = Self::constant(rat_one());
        let [u, v, w] = std::array::from_fn(Self::coordinate);
        self.compose(&[u.clone(), one.sub(&u).mul(&v), one.sub(&u).mul(&one.sub(&v)).mul(&w)])
    }
    fn trimmed(self) -> Self {
        let mut degree = [0; 3];
        for (i, value) in self.coefficients.iter().enumerate() {
            if !rat_is_zero(value) {
                let e = exponents(self.degree, i);
                for k in 0..3 {
                    degree[k] = degree[k].max(e[k]);
                }
            }
        }
        if degree == self.degree {
            return self;
        }
        let mut result = Self::zero(degree);
        for (i, value) in self.coefficients.into_iter().enumerate() {
            if !rat_is_zero(&value) {
                result.coefficients[index(degree, exponents(self.degree, i))] = value;
            }
        }
        result
    }

    fn zero(degree: [usize; 3]) -> Self {
        Self { degree, coefficients: vec![rat_zero(); count(degree)] }
    }

    fn constant(value: Rational) -> Self {
        Self { degree: [0; 3], coefficients: vec![value] }
    }

    fn add(&self, other: &Self) -> Self {
        let degree = std::array::from_fn(|k| self.degree[k].max(other.degree[k]));
        let mut result = Self::zero(degree);
        for input in [self, other] {
            for (i, coefficient) in input.coefficients.iter().enumerate() {
                let at = index(degree, exponents(input.degree, i));
                result.coefficients[at] += coefficient;
            }
        }
        result.trimmed()
    }

    fn scale(&self, factor: &Rational) -> Self {
        Self { degree: self.degree, coefficients: self.coefficients.iter().map(|c| c * factor).collect() }.trimmed()
    }

    fn sub(&self, other: &Self) -> Self {
        self.add(&other.scale(&-rat_one()))
    }

    fn mul(&self, other: &Self) -> Self {
        let degree = std::array::from_fn(|k| self.degree[k] + other.degree[k]);
        let mut result = Self::zero(degree);
        for (i, a) in self.coefficients.iter().enumerate() {
            if rat_is_zero(a) {
                continue;
            }
            let ea = exponents(self.degree, i);
            for (j, b) in other.coefficients.iter().enumerate() {
                let eb = exponents(other.degree, j);
                let at = index(degree, std::array::from_fn(|k| ea[k] + eb[k]));
                result.coefficients[at] += a * b;
            }
        }
        result.trimmed()
    }

    fn derivative(&self, axis: usize) -> Self {
        let mut degree = self.degree;
        degree[axis] = degree[axis].saturating_sub(1);
        let mut result = Self::zero(degree);
        for (i, coefficient) in self.coefficients.iter().enumerate() {
            let mut e = exponents(self.degree, i);
            if e[axis] > 0 {
                let value = coefficient * fraction(e[axis], 1);
                e[axis] -= 1;
                result.coefficients[index(degree, e)] = value;
            }
        }
        result.trimmed()
    }

    fn evaluate(&self, at: &[Rational; 3]) -> Rational {
        let mut result = rat_zero();
        for z in (0..=self.degree[2]).rev() {
            let mut plane = rat_zero();
            for y in (0..=self.degree[1]).rev() {
                let mut row = rat_zero();
                for x in (0..=self.degree[0]).rev() {
                    row = row * &at[0] + &self.coefficients[index(self.degree, [x, y, z])];
                }
                plane = plane * &at[1] + row;
            }
            result = result * &at[2] + plane;
        }
        result
    }

    fn reverse_axis(&self, axis: usize) -> Self {
        let mut result = Self::zero(self.degree);
        for (i, coefficient) in self.coefficients.iter().enumerate() {
            let mut e = exponents(self.degree, i);
            let power = e[axis];
            for j in 0..=power {
                e[axis] = j;
                let factor = fraction(choose(power, j), 1);
                let value = coefficient * factor;
                let at = index(self.degree, e);
                if j % 2 == 0 {
                    result.coefficients[at] += value;
                } else {
                    result.coefficients[at] -= value;
                }
            }
        }
        result
    }

    /// p = coordinate_axis * quotient + remainder, exactly.
    fn take_factor(&self, axis: usize) -> (Self, Self) {
        let mut degree = self.degree;
        degree[axis] = degree[axis].saturating_sub(1);
        let mut quotient = Self::zero(degree);
        let mut remainder_degree = self.degree;
        remainder_degree[axis] = 0;
        let mut remainder = Self::zero(remainder_degree);
        for (i, coefficient) in self.coefficients.iter().enumerate() {
            let mut e = exponents(self.degree, i);
            if e[axis] == 0 {
                remainder.coefficients[index(remainder_degree, e)] = coefficient.clone();
            } else {
                e[axis] -= 1;
                quotient.coefficients[index(degree, e)] = coefficient.clone();
            }
        }
        (quotient, remainder)
    }

    fn bernstein(&self) -> Self {
        let mut result = self.clone();
        for axis in 0..3 {
            let previous = result.coefficients.clone();
            for (i, output) in result.coefficients.iter_mut().enumerate() {
                let mut e = exponents(self.degree, i);
                let end = e[axis];
                *output = rat_zero();
                for k in 0..=end {
                    e[axis] = k;
                    *output +=
                        &previous[index(self.degree, e)] * fraction(choose(end, k), choose(self.degree[axis], k));
                }
            }
        }
        result
    }

    /// de Casteljau subdivision at exactly one half; input/output are Bernstein.
    fn split(&self, axis: usize) -> (Self, Self) {
        let mut left = Self::zero(self.degree);
        let mut right = Self::zero(self.degree);
        for i in 0..self.coefficients.len() {
            let mut e = exponents(self.degree, i);
            if e[axis] != 0 {
                continue;
            }
            let n = self.degree[axis];
            let mut line: Vec<_> = (0..=n)
                .map(|j| {
                    e[axis] = j;
                    self.coefficients[index(self.degree, e)].clone()
                })
                .collect();
            e[axis] = 0;
            left.coefficients[index(self.degree, e)] = line[0].clone();
            e[axis] = n;
            right.coefficients[index(self.degree, e)] = line[n].clone();
            for level in 1..=n {
                for j in 0..=n - level {
                    line[j] = (&line[j] + &line[j + 1]) * fraction(1, 2);
                }
                e[axis] = level;
                left.coefficients[index(self.degree, e)] = line[0].clone();
                e[axis] = n - level;
                right.coefficients[index(self.degree, e)] = line[n - level].clone();
            }
        }
        (left, right)
    }
}

fn positive_bernstein(polynomial: Polynomial, depth: usize, remaining: &mut usize) -> bool {
    if *remaining == 0 {
        return false;
    }
    *remaining -= 1;
    if polynomial.coefficients.iter().all(|c| Sign::of_rat(c) == Sign::Pos) {
        return true;
    }
    // Tensor corner coefficients are exact values, so no refinement can prove
    // strict positivity if one of those corners is nonpositive.
    if HEX_BITS.iter().any(|bits| {
        Sign::of_rat(
            &polynomial.coefficients[index(polynomial.degree, std::array::from_fn(|k| bits[k] * polynomial.degree[k]))],
        ) != Sign::Pos
    }) || depth == MAX_DEPTH
    {
        return false;
    }
    let (left, right) = polynomial.split(depth % 3);
    positive_bernstein(left, depth + 1, remaining) && positive_bernstein(right, depth + 1, remaining)
}

fn prove_positive(polynomial: &Polynomial, remaining: &mut usize) -> bool {
    positive_bernstein(polynomial.bernstein(), 0, remaining)
}

fn determinant(m: &[[Rational; 3]; 3]) -> Rational {
    &m[0][0] * (&m[1][1] * &m[2][2] - &m[1][2] * &m[2][1]) - &m[0][1] * (&m[1][0] * &m[2][2] - &m[1][2] * &m[2][0])
        + &m[0][2] * (&m[1][0] * &m[2][1] - &m[1][1] * &m[2][0])
}

fn polynomial_determinant(m: &[[Polynomial; 3]; 3]) -> Polynomial {
    m[0][0]
        .mul(&m[1][1].mul(&m[2][2]).sub(&m[1][2].mul(&m[2][1])))
        .sub(&m[0][1].mul(&m[1][0].mul(&m[2][2]).sub(&m[1][2].mul(&m[2][0]))))
        .add(&m[0][2].mul(&m[1][0].mul(&m[2][1]).sub(&m[1][1].mul(&m[2][0]))))
}

/// Exact Abaqus interpolation on [0,1]^3 or the unit tetrahedron. These are
/// geometry polynomials, not a CPU duplicate used as a numerical solver oracle.
fn source_shapes(kind: ElementKind) -> Vec<Polynomial> {
    let one = Polynomial::constant(rat_one());
    let xyz: [Polynomial; 3] = std::array::from_fn(Polynomial::coordinate);
    if kind == ElementKind::Tet4 || kind == ElementKind::Tet10 {
        let barycentric = [one.sub(&xyz[0]).sub(&xyz[1]).sub(&xyz[2]), xyz[0].clone(), xyz[1].clone(), xyz[2].clone()];
        if kind == ElementKind::Tet4 {
            return barycentric.to_vec();
        }
        let mut result: Vec<_> = barycentric.iter().map(|v| v.mul(&v.scale(&fraction(2, 1)).sub(&one))).collect();
        result.extend(
            kind.edges()
                .iter()
                .map(|&[a, b]| barycentric[a as usize].mul(&barycentric[b as usize]).scale(&fraction(4, 1))),
        );
        return result;
    }
    let linear: Vec<[Polynomial; 3]> = HEX_BITS
        .iter()
        .map(|bits| std::array::from_fn(|k| if bits[k] == 0 { one.sub(&xyz[k]) } else { xyz[k].clone() }))
        .collect();
    let mut result: Vec<_> = linear
        .iter()
        .map(|factors| {
            let corner = factors[0].mul(&factors[1]).mul(&factors[2]);
            if kind == ElementKind::Hex8 {
                corner
            } else {
                corner.mul(
                    &factors[0]
                        .add(&factors[1])
                        .add(&factors[2])
                        .scale(&fraction(2, 1))
                        .sub(&Polynomial::constant(fraction(5, 1))),
                )
            }
        })
        .collect();
    if kind == ElementKind::Hex20 {
        result.extend(kind.edges().iter().map(|&[a, b]| {
            let axis = (0..3)
                .find(|&k| HEX_BITS[a as usize][k] != HEX_BITS[b as usize][k])
                .expect("edge varies along one axis");
            let mut shape = xyz[axis].mul(&one.sub(&xyz[axis])).scale(&fraction(4, 1));
            for (k, factor) in linear[a as usize].iter().enumerate() {
                if k != axis {
                    shape = shape.mul(factor);
                }
            }
            shape
        }));
    }
    result
}

struct Cell {
    element: u32,
    kind: ElementKind,
    nodes: Vec<u32>,
    points: Vec<R3>,
    map: [Polynomial; 3],
    lo: [Rational; 3],
    hi: [Rational; 3],
}

impl Cell {
    fn new(mesh: &Mesh, element: u32) -> Self {
        let kind = mesh.kind_of(element);
        let nodes = mesh.elem_nodes(element).to_vec();
        let coordinates: Vec<_> = nodes.iter().map(|&node| mesh.node(node)).collect();
        let points: Vec<_> = coordinates.iter().map(|p| R3::from_vec3(Vec3::new(p[0], p[1], p[2]))).collect();
        let shape = source_shapes(kind);
        let map = std::array::from_fn(|component| {
            let mut polynomial = Polynomial::constant(rat_zero());
            for (point, shape) in points.iter().zip(&shape) {
                polynomial = polynomial.add(&shape.scale([&point.x, &point.y, &point.z][component]));
            }
            polynomial
        });
        // Quadratic maps can bulge beyond every nodal coordinate. Bound the original
        // polynomial image by its exact Bernstein convex hull, never a nodal AABB.
        // Duffy bounds the simplex image without enlarging it to a reference cube.
        let image: [Polynomial; 3] = std::array::from_fn(|k| {
            if kind == ElementKind::Tet4 || kind == ElementKind::Tet10 {
                map[k].on_simplex().bernstein()
            } else {
                map[k].bernstein()
            }
        });
        let lo = std::array::from_fn(|k| image[k].coefficients.iter().min().expect("nonempty polynomial").clone());
        let hi = std::array::from_fn(|k| image[k].coefficients.iter().max().expect("nonempty polynomial").clone());
        Self { element, kind, nodes, points, map, lo, hi }
    }

    fn is_affine_tetrahedron(&self) -> bool {
        (self.kind == ElementKind::Tet4 || self.kind == ElementKind::Tet10)
            && self.map.iter().all(|p| {
                p.coefficients
                    .iter()
                    .enumerate()
                    .all(|(i, c)| exponents(p.degree, i).iter().sum::<usize>() <= 1 || rat_is_zero(c))
            })
    }

    fn certify_injective(&self) -> Result<(), ImportedCertificateError> {
        if self.kind == ElementKind::Tet4 {
            if orient3d_r(&self.points[0], &self.points[1], &self.points[2], &self.points[3]) != Sign::Pos {
                return Err(ImportedCertificateError::Invalid {
                    elements: vec![self.element],
                    cause: "tetrahedron has a nonpositive exact Jacobian".into(),
                });
            }
            return Ok(());
        }
        let jacobian: [[Polynomial; 3]; 3] =
            std::array::from_fn(|i| std::array::from_fn(|j| self.map[i].derivative(j)));
        for x in 0..3 {
            for y in 0..3 {
                for z in 0..3 {
                    if self.kind == ElementKind::Tet10 && x + y + z > 2 {
                        continue;
                    }
                    let at = [fraction(x, 2), fraction(y, 2), fraction(z, 2)];
                    let sample = std::array::from_fn(|i| std::array::from_fn(|j| jacobian[i][j].evaluate(&at)));
                    if Sign::of_rat(&determinant(&sample)) != Sign::Pos {
                        return Err(ImportedCertificateError::Invalid {
                            elements: vec![self.element],
                            cause: format!(
                                "{:?} has a nonpositive exact Jacobian at reference [{x}/2,{y}/2,{z}/2]",
                                self.kind
                            ),
                        });
                    }
                }
            }
        }
        let center: [[Rational; 3]; 3] = std::array::from_fn(|i| {
            std::array::from_fn(|j| {
                let center = if self.kind == ElementKind::Tet10 { fraction(1, 4) } else { fraction(1, 2) };
                jacobian[i][j].evaluate(&[center.clone(), center.clone(), center])
            })
        });
        let adjugate: [[Rational; 3]; 3] = std::array::from_fn(|i| {
            std::array::from_fn(|j| {
                &center[(j + 1) % 3][(i + 1) % 3] * &center[(j + 2) % 3][(i + 2) % 3]
                    - &center[(j + 1) % 3][(i + 2) % 3] * &center[(j + 2) % 3][(i + 1) % 3]
            })
        });
        if self.kind == ElementKind::Tet10 || self.kind == ElementKind::Hex20 {
            let normalized: [[Polynomial; 3]; 3] = std::array::from_fn(|i| {
                std::array::from_fn(|j| {
                    (0..3).fold(Polynomial::constant(rat_zero()), |sum, k| {
                        sum.add(&jacobian[k][j].scale(&adjugate[i][k]))
                    })
                })
            });
            let symmetric: [[Polynomial; 3]; 3] = std::array::from_fn(|i| {
                std::array::from_fn(|j| normalized[i][j].add(&normalized[j][i]).scale(&fraction(1, 2)))
            });
            let minors = [
                symmetric[0][0].clone(),
                symmetric[0][0].mul(&symmetric[1][1]).sub(&symmetric[0][1].mul(&symmetric[1][0])),
                polynomial_determinant(&symmetric),
            ];
            let mut remaining = MAX_BOXES;
            if !minors.iter().all(|minor| {
                let domain = if self.kind == ElementKind::Tet10 { minor.on_simplex() } else { minor.clone() };
                prove_positive(&domain, &mut remaining)
            }) {
                return Err(ImportedCertificateError::Inconclusive { elements:vec![self.element], cause: "bounded exact normalized-Jacobian certificate could not prove quadratic cell global injectivity".into() });
            }
            return Ok(());
        }
        // J and Sym(AJ) are multi-affine, so the interior matrix is exactly a
        // convex combination of the eight corner matrices. The SPD cone is
        // convex. This is a matrix certificate, not sampled det(J) acceptance.
        for bits in HEX_BITS {
            let at = bits.map(|bit| fraction(bit, 1));
            let normalized: [[Rational; 3]; 3] = std::array::from_fn(|i| {
                std::array::from_fn(|j| {
                    (0..3).fold(rat_zero(), |sum, k| sum + &adjugate[i][k] * jacobian[k][j].evaluate(&at))
                })
            });
            let symmetric: [[Rational; 3]; 3] = std::array::from_fn(|i| {
                std::array::from_fn(|j| (&normalized[i][j] + &normalized[j][i]) * fraction(1, 2))
            });
            let minors = [
                symmetric[0][0].clone(),
                &symmetric[0][0] * &symmetric[1][1] - &symmetric[0][1] * &symmetric[1][0],
                determinant(&symmetric),
            ];
            if minors.iter().any(|minor| Sign::of_rat(minor) != Sign::Pos) {
                return Err(ImportedCertificateError::Inconclusive {
                    elements: vec![self.element],
                    cause: "exact normalized-Jacobian matrix certificate could not prove Hex8 global injectivity"
                        .into(),
                });
            }
        }
        Ok(())
    }
}

/// q(x) = linear dot (x-origin) - (u dot (x-origin))*(v dot (x-origin)).
/// A planar patch has no quadratic term. For a nonplanar bilinear patch
/// a+b*s+c*t+d*s*t, choose D=b dot (c cross d), linear=D*(b cross c),
/// u=c cross d, v=d cross b. Then q=D²*(W-U*V) in affine patch coordinates.
struct ImplicitFace {
    origin: R3,
    linear: R3,
    product: Option<(R3, R3)>,
    implicit: Option<Polynomial>,
}

impl ImplicitFace {
    fn new(cell: &Cell, face: usize) -> Self {
        let mut result = Self::corner_separator(cell, face);
        if cell.kind == ElementKind::Tet10 || cell.kind == ElementKind::Hex20 {
            result.implicit = implicit_surface(cell, face, if cell.kind == ElementKind::Tet10 { 3 } else { 2 });
        }
        result
    }

    fn corner_separator(cell: &Cell, face: usize) -> Self {
        let local = cell.kind.face_nodes(face);
        let origin = cell.points[local[0] as usize].clone();
        let b = cell.points[local[1] as usize].sub(&origin);
        let c = cell.points[local[cell.kind.face_kind().n_corners() - 1] as usize].sub(&origin);
        let normal = b.cross(&c);
        if cell.kind == ElementKind::Tet4 || cell.kind == ElementKind::Tet10 {
            return Self { origin, linear: normal, product: None, implicit: None };
        }
        let d = cell.points[local[2] as usize].sub(&origin).sub(&b).sub(&c);
        let u = c.cross(&d);
        let determinant = b.dot(&u);
        if rat_is_zero(&determinant) {
            Self { origin, linear: normal, product: None, implicit: None }
        } else {
            Self { origin, linear: normal.scale(&determinant), product: Some((u, d.cross(&b))), implicit: None }
        }
    }

    fn evaluate(&self, point: &R3) -> Rational {
        if let Some(quadratic) = &self.implicit {
            return quadratic.evaluate(&[point.x.clone(), point.y.clone(), point.z.clone()]);
        }
        let relative = point.sub(&self.origin);
        let linear = self.linear.dot(&relative);
        match &self.product {
            Some((u, v)) => linear - u.dot(&relative) * v.dot(&relative),
            None => linear,
        }
    }

    fn compose(&self, map: &[Polynomial; 3]) -> Polynomial {
        if let Some(quadratic) = &self.implicit {
            return quadratic.compose(map);
        }
        let origin = [&self.origin.x, &self.origin.y, &self.origin.z];
        let relative: [Polynomial; 3] = std::array::from_fn(|k| map[k].sub(&Polynomial::constant(origin[k].clone())));
        let linear = linear_combination(&relative, &self.linear);
        match &self.product {
            Some((u, v)) => linear.sub(&linear_combination(&relative, u).mul(&linear_combination(&relative, v))),
            None => linear,
        }
    }
}

/// Reference nodes in half-unit coordinates, corners first and Abaqus edges next.
fn reference_nodes(kind: ElementKind) -> Vec<[usize; 3]> {
    let corners = if kind == ElementKind::Tet4 || kind == ElementKind::Tet10 {
        vec![[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2]]
    } else {
        HEX_BITS.map(|p| p.map(|v| 2 * v)).to_vec()
    };
    let mut result = corners.clone();
    if kind.n_nodes() != kind.n_corners() {
        result.extend(
            kind.edges()
                .iter()
                .map(|&[a, b]| std::array::from_fn(|k| (corners[a as usize][k] + corners[b as usize][k]) / 2)),
        );
    }
    result
}

/// Recover a bounded implicit polynomial only when its composition with the
/// complete original face is identically zero. Tet10 uses at most twenty cubic
/// monomials (at most 49 bivariate tensor coefficient rows); Hex20 retains ten quadratic
/// monomials. Nodal fitting alone is insufficient. Higher implicit degree remains
/// inconclusive. The first free column selects the lowest available total degree.
fn implicit_surface(cell: &Cell, face: usize, maximum_degree: usize) -> Option<Polynomial> {
    let reference: Vec<[usize; 3]> = if cell.kind == ElementKind::Tet10 {
        vec![[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]
    } else {
        HEX_BITS.to_vec()
    };
    let corners = &cell.kind.face_nodes(face)[..cell.kind.face_kind().n_corners()];
    let origin = reference[corners[0] as usize];
    let a = reference[corners[1] as usize];
    let b = reference[*corners.last().expect("solid face") as usize];
    let uv: [Polynomial; 3] = std::array::from_fn(|k| {
        let c = Polynomial::constant(fraction(origin[k], 1));
        c.add(&Polynomial::coordinate(0).scale(&(fraction(a[k], 1) - fraction(origin[k], 1))))
            .add(&Polynomial::coordinate(1).scale(&(fraction(b[k], 1) - fraction(origin[k], 1))))
    });
    let face_map: [Polynomial; 3] = std::array::from_fn(|k| cell.map[k].compose(&uv));
    let powers = [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [2, 0, 0],
        [1, 1, 0],
        [1, 0, 1],
        [0, 2, 0],
        [0, 1, 1],
        [0, 0, 2],
        [3, 0, 0],
        [2, 1, 0],
        [2, 0, 1],
        [1, 2, 0],
        [1, 1, 1],
        [1, 0, 2],
        [0, 3, 0],
        [0, 2, 1],
        [0, 1, 2],
        [0, 0, 3],
    ];
    let basis: Vec<_> = powers
        .iter()
        .filter(|power| power.iter().sum::<usize>() <= maximum_degree)
        .map(|&power| {
            let mut p = Polynomial::zero(power);
            p.coefficients[index(power, power)] = rat_one();
            p
        })
        .collect();
    let columns: Vec<_> = basis.iter().map(|p| p.compose(&face_map)).collect();
    let degree = std::array::from_fn(|k| columns.iter().map(|p| p.degree[k]).max().expect("bounded implicit basis"));
    let mut rows: Vec<Vec<Rational>> = (0..count(degree))
        .map(|i| {
            let e = exponents(degree, i);
            columns
                .iter()
                .map(|p| {
                    if (0..3).all(|k| e[k] <= p.degree[k]) {
                        p.coefficients[index(p.degree, e)].clone()
                    } else {
                        rat_zero()
                    }
                })
                .collect()
        })
        .collect();
    let mut pivots = Vec::new();
    for column in 0..basis.len() {
        let Some(pivot) = (pivots.len()..rows.len()).find(|&r| !rat_is_zero(&rows[r][column])) else {
            continue;
        };
        let row = pivots.len();
        rows.swap(row, pivot);
        let scale = rows[row][column].clone();
        for value in &mut rows[row] {
            *value /= &scale;
        }
        let pivot_values = rows[row].clone();
        for (r, values) in rows.iter_mut().enumerate() {
            if r != row {
                let factor = values[column].clone();
                for (value, pivot) in values[column..].iter_mut().zip(&pivot_values[column..]) {
                    *value -= pivot * &factor;
                }
            }
        }
        pivots.push(column);
    }
    let free = (0..basis.len()).find(|c| !pivots.contains(c))?;
    let mut coefficients = vec![rat_zero(); basis.len()];
    coefficients[free] = rat_one();
    for (row, &column) in pivots.iter().enumerate() {
        coefficients[column] = -&rows[row][free];
    }
    Some(
        basis
            .iter()
            .zip(coefficients)
            .fold(Polynomial::constant(rat_zero()), |p, (term, value)| p.add(&term.scale(&value))),
    )
}

fn linear_combination(map: &[Polynomial; 3], vector: &R3) -> Polynomial {
    map[0].scale(&vector.x).add(&map[1].scale(&vector.y)).add(&map[2].scale(&vector.z))
}

struct Side {
    sign: Sign,
    zero_nodes: Vec<u32>,
}

fn certify_side(face: &ImplicitFace, cell: &Cell, remaining: &mut usize) -> Option<Side> {
    let values: Vec<_> = cell.points.iter().map(|point| face.evaluate(point)).collect();
    let sign = values.iter().map(Sign::of_rat).find(|s| *s != Sign::Zero)?;
    if values.iter().any(|value| Sign::of_rat(value) == sign.flip()) {
        return None;
    }
    let zero: Vec<_> = values.iter().enumerate().filter(|(_, value)| rat_is_zero(value)).map(|(i, _)| i).collect();
    let quadratic = face.implicit.as_ref().is_none_or(|p| {
        p.coefficients
            .iter()
            .enumerate()
            .all(|(i, c)| rat_is_zero(c) || exponents(p.degree, i).iter().sum::<usize>() <= 2)
    });
    if cell.kind == ElementKind::Tet4 && quadratic {
        // Degree-two simplex Bernstein coefficients: vertices plus six edges.
        // Nonnegative coefficients and positive vertex coefficients away from Z
        // prove q>0 outside hull(Z). Coefficients within Z must all be zero.
        for i in 0..4 {
            for j in i + 1..4 {
                let midpoint = cell.points[i].add(&cell.points[j]).scale(&fraction(1, 2));
                let coefficient =
                    face.evaluate(&midpoint) * fraction(2, 1) - (&values[i] + &values[j]) * fraction(1, 2);
                if Sign::of_rat(&coefficient) == sign.flip()
                    || (zero.contains(&i) && zero.contains(&j) && !rat_is_zero(&coefficient))
                {
                    return None;
                }
            }
        }
    } else {
        let mut polynomial = face.compose(&cell.map);
        if sign == Sign::Neg {
            polynomial = polynomial.scale(&-rat_one());
        }
        let simplex = cell.kind == ElementKind::Tet4 || cell.kind == ElementKind::Tet10;
        if zero.is_empty() {
            let domain = if simplex { polynomial.on_simplex() } else { polynomial };
            if !prove_positive(&domain, remaining) {
                return None;
            }
        } else {
            let reference = reference_nodes(cell.kind);
            let mut fixed = Vec::new();
            if simplex {
                // λ0+λ1+λ2+λ3=1. Reorder barycentric vertices so λ0 is not
                // excluded, then each excluded λ is an ordinary coordinate.
                let barycentric: Vec<[usize; 4]> =
                    reference.iter().map(|p| [2 - p.iter().sum::<usize>(), p[0], p[1], p[2]]).collect();
                let excluded: Vec<_> = (0..4).filter(|&k| zero.iter().all(|&i| barycentric[i][k] == 0)).collect();
                let expected: Vec<_> =
                    (0..reference.len()).filter(|&i| excluded.iter().all(|&k| barycentric[i][k] == 0)).collect();
                if excluded.is_empty() || expected != zero {
                    return None;
                }
                let anchor = (0..4).find(|k| !excluded.contains(k)).expect("nonempty simplex entity");
                let permutation: Vec<_> = std::iter::once(anchor).chain((0..4).filter(|&k| k != anchor)).collect();
                let xyz: [Polynomial; 3] = std::array::from_fn(Polynomial::coordinate);
                let bary = [
                    Polynomial::constant(rat_one()).sub(&xyz[0]).sub(&xyz[1]).sub(&xyz[2]),
                    xyz[0].clone(),
                    xyz[1].clone(),
                    xyz[2].clone(),
                ];
                let map = std::array::from_fn(|k| {
                    bary[permutation.iter().position(|&old| old == k + 1).expect("vertex permutation")].clone()
                });
                polynomial = polynomial.compose(&map);
                fixed.extend(
                    excluded
                        .iter()
                        .map(|old| (permutation.iter().position(|k| k == old).expect("excluded vertex") - 1, 0)),
                );
            } else {
                // Corner-first quadratic faces have additional mid-edge nodes;
                // classify the complete reference entity, never just its corners.
                fixed.extend((0..3).filter_map(|axis| {
                    let value = reference[zero[0]][axis];
                    (value != 1 && zero.iter().all(|&i| reference[i][axis] == value)).then_some((axis, value / 2))
                }));
                let expected: Vec<_> = (0..reference.len())
                    .filter(|&i| fixed.iter().all(|&(axis, bit)| reference[i][axis] == 2 * bit))
                    .collect();
                if fixed.is_empty() || expected != zero {
                    return None;
                }
                for &(axis, bit) in &fixed {
                    if bit == 1 {
                        polynomial = polynomial.reverse_axis(axis);
                    }
                }
            }
            // Exact p=Σ coordinate_i*H_i, H_i>0, proves precisely the labelled
            // reference face/edge/vertex. No point samples stand in for contact.
            let mut quotients = Vec::with_capacity(fixed.len());
            for &(axis, _) in &fixed {
                let (quotient, remainder) = polynomial.take_factor(axis);
                quotients.push(quotient);
                polynomial = remainder;
            }
            if !polynomial.coefficients.iter().all(rat_is_zero) {
                return None;
            }
            if !quotients.iter().all(|q| {
                let domain = if simplex { q.on_simplex() } else { q.clone() };
                prove_positive(&domain, remaining)
            }) {
                return None;
            }
        }
    }
    let mut zero_nodes: Vec<_> = zero.iter().map(|&i| cell.nodes[i]).collect();
    zero_nodes.sort_unstable();
    Some(Side { sign, zero_nodes })
}

fn intersect_labels(current: &mut Vec<u32>, other: &[u32]) {
    current.retain(|node| other.contains(node));
}

/// Same labels alone do not identify a quadratic patch: midpoint labels must
/// belong to the same corner edges. A corner-cycle isomorphism then fixes every
/// coefficient of its Tri6/Quad8 interpolation, and hence the complete shared map.
fn matching_entity(a: &Cell, b: &Cell, common: &[u32]) -> bool {
    if common.len() == 1 {
        // With asymmetric zero entities, a singleton must still be a COMPLETE
        // entity of both cells: a vertex on the other's midside node is hanging.
        return a.nodes[..a.kind.n_corners()].contains(&common[0])
            && b.nodes[..b.kind.n_corners()].contains(&common[0]);
    }
    let entities = |cell: &Cell| {
        let mut result = Vec::new();
        for (i, &[u, v]) in cell.kind.edges().iter().enumerate() {
            let mut nodes = vec![cell.nodes[u as usize], cell.nodes[v as usize]];
            if cell.kind.n_nodes() != cell.kind.n_corners() {
                nodes.push(cell.nodes[cell.kind.n_corners() + i]);
            }
            result.push((2, nodes));
        }
        for f in 0..cell.kind.n_faces() {
            result.push((
                cell.kind.face_kind().n_corners(),
                cell.kind.face_nodes(f).iter().map(|&i| cell.nodes[i as usize]).collect(),
            ));
        }
        result
    };
    for (corners, an) in entities(a) {
        let mut key = an.clone();
        key.sort_unstable();
        if key != common {
            continue;
        }
        for (bc, bn) in entities(b) {
            if corners != bc || an.len() != bn.len() {
                continue;
            }
            for start in 0..corners {
                for reverse in [false, true] {
                    let at = |i: usize| {
                        if reverse {
                            (start + corners - i % corners) % corners
                        } else {
                            (start + i) % corners
                        }
                    };
                    let equal = (0..corners).all(|i| an[i] == bn[at(i)]);
                    let edges = (corners..an.len()).all(|i| {
                        if corners == 2 {
                            return an[i] == bn[i];
                        }
                        let edge = i - corners;
                        let other = if reverse { at(edge + 1) } else { at(edge) };
                        an[i] == bn[corners + other]
                    });
                    if equal && edges {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn zero_vertex<'a>(cell: &'a Cell, zero: &[u32]) -> Option<&'a R3> {
    if zero.len() != 1 {
        return None;
    }
    cell.nodes[..cell.kind.n_corners()].iter().position(|node| *node == zero[0]).map(|i| &cell.points[i])
}

/// Discover bounded candidate separating planes at a shared tetrahedral corner.
/// The six oriented corner rays require n·ray>0. Any feasible strict cone can
/// be scaled to n·ray>=1; a full-rank three-dimensional feasible polyhedron has
/// a vertex at three active planes. Enumerate its at most 20 exact triples.
/// Corner feasibility ONLY chooses a direction: the ordinary exact original-map
/// sign/zero-entity proof remains the sole geometric admission criterion. Try
/// every corner-feasible candidate within the shared proof budget; a curved
/// bulge may invalidate the first while a later plane succeeds.
fn vertex_cone_planes(a: &Cell, b: &Cell, common: &[u32]) -> Vec<ImplicitFace> {
    if a.kind.n_corners() != 4 || b.kind.n_corners() != 4 {
        return Vec::new();
    }
    let Some(origin) = zero_vertex(a, common).cloned() else {
        return Vec::new();
    };
    if zero_vertex(b, common).is_none() {
        return Vec::new();
    }
    let mut rays = Vec::with_capacity(6);
    for (node, p) in a.nodes[..4].iter().zip(&a.points[..4]) {
        if *node != common[0] {
            rays.push(origin.sub(p));
        }
    }
    for (node, p) in b.nodes[..4].iter().zip(&b.points[..4]) {
        if *node != common[0] {
            rays.push(p.sub(&origin));
        }
    }
    let mut planes = Vec::new();
    for i in 0..rays.len() {
        for j in i + 1..rays.len() {
            for k in j + 1..rays.len() {
                let jk = rays[j].cross(&rays[k]);
                let det = rays[i].dot(&jk);
                if rat_is_zero(&det) {
                    continue;
                }
                // Cramer's rule for rows ray_i,ray_j,ray_k and right-hand side 1.
                let normal = jk.add(&rays[k].cross(&rays[i])).add(&rays[i].cross(&rays[j])).scale(&(rat_one() / det));
                if rays.iter().all(|ray| Sign::of_rat(&ray.dot(&normal)) == Sign::Pos) {
                    planes.push(ImplicitFace { origin: origin.clone(), linear: normal, product: None, implicit: None });
                }
            }
        }
    }
    planes
}

fn certify_pair(a: &Cell, b: &Cell) -> bool {
    let mut common: Vec<_> = a.nodes.iter().filter(|node| b.nodes.contains(node)).copied().collect();
    common.sort_unstable();
    let mut zero_a = a.nodes.clone();
    let mut zero_b = b.nodes.clone();
    zero_a.sort_unstable();
    zero_b.sort_unstable();
    let mut remaining = MAX_BOXES;
    let faces =
        [a, b].into_iter().flat_map(|owner| (0..owner.kind.n_faces()).map(move |face| ImplicitFace::new(owner, face)));
    for face in faces.chain(vertex_cone_planes(a, b, &common)) {
        let side_a = certify_side(&face, a, &mut remaining);
        let side_b = certify_side(&face, b, &mut remaining);
        if let (Some(sa), Some(sb)) = (side_a, side_b) {
            if sa.sign == sb.sign {
                continue;
            }
            // Every common physical point must be a zero of every proven
            // separator. Intersections of reference entities are reference
            // entities because each cell has already proved injectivity.
            intersect_labels(&mut zero_a, &sa.zero_nodes);
            intersect_labels(&mut zero_b, &sb.zero_nodes);
            // Both original maps have proved injectivity. If either zero
            // entity is precisely the complete common labelled entity, the
            // physical intersection is already contained in that entity;
            // the other zero entity can be larger. Complete correspondence
            // below proves both cells parameterize that SAME entity,
            // including all quadratic mid-edge incidence. Requiring BOTH
            // zero entities to be minimal would reject valid vertex/edge
            // contacts between otherwise exactly separated curved cells.
            // Injectivity makes intersections of the reference entities
            // exact; complete cyclic/edge incidence determines their
            // linear or quadratic interpolation under reparameterization.
            // Nonempty localized entities can also have empty PHYSICAL
            // intersection: two distinct exact vertices are disjoint even
            // though both lists contain a node. Coincident differently
            // labelled vertices deliberately fail this check.
            let distinct_vertices =
                zero_vertex(a, &zero_a).zip(zero_vertex(b, &zero_b)).is_some_and(|(pa, pb)| pa != pb);
            if zero_a.is_empty()
                || zero_b.is_empty()
                || distinct_vertices
                || ((zero_a == common || zero_b == common) && matching_entity(a, b, &common))
            {
                return true;
            }
        }
    }
    false
}

/// Certify Tet4/Tet10/Hex8/Hex20 original geometry, or reject without mutating the mesh.
/// Connectivity and finite coordinates must already be validated by the caller.
/// Topological connectedness/manifoldness is a separate importing-host check.
///
/// For Hex8, let A=adj(J(center)). Exact Sylvester checks prove all eight corner
/// matrices M=(A*J+(A*J)^T)/2 are SPD. M is multi-affine, so everywhere on the cube
/// it is a convex combination of those eight matrices. Convexity of the SPD cone
/// gives a uniform positive eigenvalue bound; this is a matrix proof, not sampled
/// Jacobian-determinant acceptance. Integrating along the straight
/// reference segment gives (xi-eta) dot A*(F(xi)-F(eta))>0 for xi!=eta, proving
/// global injectivity. M>0 also makes J nonsingular; its positive center determinant
/// fixes its sign throughout the cube. Positive SI scaling multiplies J by L, A by
/// L², and each k-th Sylvester minor by L^(3k), preserving all exact sign decisions.
///
/// Pair certificates prove opposite signs of actual face plane/quadric equations
/// composed with the original maps. Exact zero-entity factorization limits every
/// contact to the same labelled vertex, edge or face on both cells. Multiple
/// separators cover edge/vertex adjacency. No approximate inverse or mesh skin is
/// used. Unsupported sufficient conditions and depth/work exhaustion fail closed.
/// Quadratic maps use polynomial Sylvester minors (Tet10 composed with Duffy),
/// exact Bernstein image bounds, and identically implicit face quadrics. Shared
/// entity identity checks every corner/mid-edge label and its reference incidence.
/// See ADR0036 for the sufficient-condition limits; arbitrary implicit faces beyond
/// the separator family may be inconclusive despite valid geometry.
/// Each pair gets at most 4096 proof boxes, split at most 12 times in fixed xyz
/// order. Broad-phase memory is linear; worst-case pair work remains quadratic.
pub fn certify_imported_geometry(mesh: &Mesh) -> Result<(), ImportedCertificateError> {
    let mut cells = Vec::with_capacity(mesh.n_elems());
    for element in 0..mesh.n_elems() as u32 {
        let kind = mesh.kind_of(element);
        if ![ElementKind::Tet4, ElementKind::Hex8, ElementKind::Tet10, ElementKind::Hex20].contains(&kind) {
            return Err(ImportedCertificateError::Inconclusive {
                elements: vec![element],
                cause: "original-geometry certificate supports only Tet4, Tet10, Hex8 and Hex20".into(),
            });
        }
        let cell = Cell::new(mesh, element);
        cell.certify_injective()?;
        cells.push(cell);
    }
    cells.sort_by(|a, b| a.lo[0].cmp(&b.lo[0]).then(a.element.cmp(&b.element)));
    let mut active: Vec<usize> = Vec::new();
    for (i, cell) in cells.iter().enumerate() {
        active.retain(|&j| cells[j].hi[0] >= cell.lo[0]);
        for &j in &active {
            let other = &cells[j];
            if (1..3).any(|k| other.hi[k] < cell.lo[k] || cell.hi[k] < other.lo[k]) {
                continue;
            }
            let elements = vec![cell.element.min(other.element), cell.element.max(other.element)];
            if cell.is_affine_tetrahedron() && other.is_affine_tetrahedron() {
                // The complete all-node map is exactly affine, so the existing
                // convex-tetrahedron intersection proof checks its ORIGINAL image.
                // This changes only the proof, never interpolation or source data.
                let mut common: Vec<_> = cell.nodes.iter().filter(|n| other.nodes.contains(n)).copied().collect();
                common.sort_unstable();
                if !crate::mesh_validation::tet_pair_is_conforming(mesh, cell.element, other.element)
                    || (!common.is_empty() && !matching_entity(cell, other, &common))
                {
                    return Err(ImportedCertificateError::Invalid {
                        elements,
                        cause: "tetrahedra overlap or meet outside their shared labelled entity".into(),
                    });
                }
            } else if !certify_pair(cell, other) {
                return Err(ImportedCertificateError::Inconclusive {
                    elements,
                    cause:
                        "bounded exact original-face separators could not prove disjoint interiors and labelled contact"
                            .into(),
                });
            }
        }
        active.push(i);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounded_original_shared_tet_face_requires_a_cubic_identity() {
        // Actual unmodified CalculiX beam10p cells 50/60. The binary midpoint
        // difference x163-y163 is 1/2+2^-55, so the original face has NO quadric.
        let first = [
            [0., 0., 2.],
            [0., 0., 4.],
            [1., 0., 4.],
            [0.499871, 0.499871, 3.99987],
            [0., 0., 3.],
            [0.5, 0., 4.],
            [0.5, 0., 3.],
            [0.249935, 0.249935, 2.99994],
            [0.249935, 0.249935, 3.99994],
            [0.749935, 0.249935, 3.99994],
        ];
        let second = [
            [0., 0., 2.],
            [1., 0., 2.],
            [0.499871, 0.499871, 3.99987],
            [1., 0., 4.],
            [0.5, 0., 2.],
            [0.749935, 0.249935, 2.99994],
            [0.249935, 0.249935, 2.99994],
            [0.5, 0., 3.],
            [1., 0., 3.],
            [0.749935, 0.249935, 3.99994],
        ];
        let mut points = Vec::new();
        let mut conn = Vec::new();
        for point in first.into_iter().chain(second) {
            let node = if let Some(i) = points.iter().position(|p| *p == point) {
                i
            } else {
                points.push(point);
                points.len() - 1
            };
            conn.push(node as u32);
        }
        let mesh = Mesh {
            dim: 3,
            coords: points.into_iter().flatten().collect(),
            blocks: vec![crate::ElementBlock { kind: ElementKind::Tet10, conn, first_elem: 0 }],
            node_sets: Default::default(),
            elem_sets: Default::default(),
            face_sets: Default::default(),
        };
        let a = Cell::new(&mesh, 0);
        let b = Cell::new(&mesh, 1);
        let face =
            (0..4).find(|&f| a.kind.face_nodes(f).iter().all(|&i| b.nodes.contains(&a.nodes[i as usize]))).unwrap();
        assert!(implicit_surface(&a, face, 2).is_none());
        let cubic = implicit_surface(&a, face, 3).unwrap();
        let degree = cubic
            .coefficients
            .iter()
            .enumerate()
            .filter(|(_, c)| !rat_is_zero(c))
            .map(|(i, _)| exponents(cubic.degree, i).iter().sum::<usize>())
            .max()
            .unwrap();
        assert_eq!(degree, 3);
        assert!(certify_pair(&a, &b));
        assert!(certify_pair(&b, &a));
    }

    #[test]
    fn cubic_separators_on_tet4_require_whole_polynomial_signs() {
        let kind = ElementKind::Tet4;
        let mesh = Mesh {
            dim: 3,
            coords: reference_nodes(kind).into_iter().flatten().map(|x| x as f64 / 2.).collect(),
            blocks: vec![crate::ElementBlock { kind, conn: vec![0, 1, 2, 3], first_elem: 0 }],
            node_sets: Default::default(),
            elem_sets: Default::default(),
            face_sets: Default::default(),
        };
        let cell = Cell::new(&mesh, 0);
        let mut p = Polynomial::zero([3, 0, 0]);
        p.coefficients = vec![rat_zero(), rat_one(), rat_zero(), rat_one()];
        let mut face = ImplicitFace {
            origin: cell.points[0].clone(),
            linear: cell.points[0].clone(),
            product: None,
            implicit: Some(p),
        };
        let mut remaining = MAX_BOXES;
        assert!(certify_side(&face, &cell, &mut remaining).is_some());
        // q=x-62x²/25+3x³/2 has positive corner and quadratic-edge shortcut
        // coefficients, but q(4/5)=-12/625. A cubic may not use that shortcut.
        face.implicit.as_mut().unwrap().coefficients = vec![rat_zero(), rat_one(), -fraction(62, 25), fraction(3, 2)];
        assert_eq!(
            face.implicit.as_ref().unwrap().evaluate(&[fraction(4, 5), rat_zero(), rat_zero()]),
            -fraction(12, 625)
        );
        let mut remaining = MAX_BOXES;
        assert!(certify_side(&face, &cell, &mut remaining).is_none());
    }

    #[test]
    fn hex20_retains_the_serendipity_total_degree_four_term() {
        // This genuine Hex20 basis term is not total-degree-two geometry.
        // F=(u+u²vw/16,v,w), det J=1+uvw/8 > 0 over the unit cube.
        let kind = ElementKind::Hex20;
        let coords = reference_nodes(kind)
            .iter()
            .flat_map(|p| {
                let [u, v, w] = p.map(|x| x as f64 / 2.);
                [u + u * u * v * w / 16., v, w]
            })
            .collect();
        let mesh = Mesh {
            dim: 3,
            coords,
            blocks: vec![crate::ElementBlock { kind, conn: (0..20).collect(), first_elem: 0 }],
            node_sets: Default::default(),
            elem_sets: Default::default(),
            face_sets: Default::default(),
        };
        let cell = Cell::new(&mesh, 0);
        let at = [fraction(1, 4), fraction(1, 2), fraction(3, 4)];
        assert_eq!(cell.map[0].evaluate(&at), fraction(515, 2048));
        assert_eq!(cell.map[0].derivative(0).evaluate(&at), fraction(259, 256));
        certify_imported_geometry(&mesh).unwrap();
    }

    #[test]
    fn quadratic_maps_keep_the_complete_polynomial_shear_between_nodes() {
        for kind in [ElementKind::Tet10, ElementKind::Hex20] {
            let reference = reference_nodes(kind);
            let coords: Vec<f64> = reference
                .iter()
                .flat_map(|p| {
                    let [x, y, z] = p.map(|v| v as f64 / 2.);
                    [x, y, z + x * (1. - x) / 4.]
                })
                .collect();
            let mesh = Mesh {
                dim: 3,
                coords,
                blocks: vec![crate::ElementBlock { kind, conn: (0..kind.n_nodes() as u32).collect(), first_elem: 0 }],
                node_sets: Default::default(),
                elem_sets: Default::default(),
                face_sets: Default::default(),
            };
            let cell = Cell::new(&mesh, 0);
            assert_eq!(zero_vertex(&cell, &[cell.nodes[0]]), Some(&cell.points[0]));
            assert!(zero_vertex(&cell, &[cell.nodes[kind.n_corners()]]).is_none());
            assert!(zero_vertex(&cell, &cell.nodes[..2]).is_none());
            let at = [fraction(1, 4), fraction(1, 8), fraction(1, 8)];
            assert_eq!(cell.map[0].evaluate(&at), fraction(1, 4));
            assert_eq!(cell.map[1].evaluate(&at), fraction(1, 8));
            assert_eq!(cell.map[2].evaluate(&at), fraction(11, 64));
            assert_eq!(cell.map[2].derivative(0).evaluate(&at), fraction(1, 8));
            assert_eq!(cell.map[2].derivative(2).evaluate(&at), rat_one());
        }
    }

    #[test]
    fn exact_polynomial_algebra_agrees_with_closed_forms_and_retains_interface_remainders() {
        // p=x²-x+13/50+y+z, with independent derivatives 2x-1,1,1.
        let mut p = Polynomial::zero([2, 1, 1]);
        p.coefficients[index(p.degree, [0, 0, 0])] = fraction(13, 50);
        p.coefficients[index(p.degree, [1, 0, 0])] = -rat_one();
        p.coefficients[index(p.degree, [2, 0, 0])] = rat_one();
        p.coefficients[index(p.degree, [0, 1, 0])] = rat_one();
        p.coefficients[index(p.degree, [0, 0, 1])] = rat_one();
        let at = [fraction(1, 3), fraction(2, 5), fraction(3, 7)];
        let expected = &at[0] * &at[0] - &at[0] + fraction(13, 50) + &at[1] + &at[2];
        assert_eq!(p.evaluate(&at), expected);
        assert_eq!(p.derivative(0).evaluate(&at), &at[0] * fraction(2, 1) - rat_one());
        assert_eq!(p.derivative(1).evaluate(&at), rat_one());
        assert_eq!(p.derivative(2).evaluate(&at), rat_one());
        assert_eq!(p.mul(&p).evaluate(&at), &expected * &expected);
        assert_eq!(p.sub(&p).evaluate(&at), rat_zero());
        for axis in 0..3 {
            let mut reversed = at.clone();
            reversed[axis] = rat_one() - &at[axis];
            assert_eq!(p.reverse_axis(axis).evaluate(&at), p.evaluate(&reversed));
            let (quotient, remainder) = p.take_factor(axis);
            assert_eq!(&at[axis] * quotient.evaluate(&at) + remainder.evaluate(&at), expected);
        }

        // q=x+y*(1-y) has zero corners on x=0 but q(0,1/2,0)=1/4.
        // The remainder must survive exact division; corner inference is insufficient.
        let mut q = Polynomial::zero([1, 2, 0]);
        q.coefficients[index(q.degree, [1, 0, 0])] = rat_one();
        q.coefficients[index(q.degree, [0, 1, 0])] = rat_one();
        q.coefficients[index(q.degree, [0, 2, 0])] = -rat_one();
        let (quotient, remainder) = q.take_factor(0);
        let midface = [rat_zero(), fraction(1, 2), rat_zero()];
        assert_eq!(quotient.evaluate(&midface), rat_one());
        assert_eq!(remainder.evaluate(&midface), fraction(1, 4));
        assert_eq!(q.evaluate(&[rat_zero(), rat_zero(), rat_zero()]), rat_zero());
        assert_eq!(q.evaluate(&[rat_zero(), rat_one(), rat_zero()]), rat_zero());
    }

    #[test]
    fn exact_bernstein_bounds_subdivide_and_fail_closed_at_depth_and_work_limits() {
        // p=(x-1/2)²+1/100 is strictly positive, while its unsplit middle
        // Bernstein coefficient is -6/25. Half subdivision proves min>=1/100.
        let mut p = Polynomial::zero([2, 0, 0]);
        p.coefficients = vec![fraction(13, 50), -rat_one(), rat_one()];
        let bernstein = p.bernstein();
        assert_eq!(bernstein.coefficients, vec![fraction(13, 50), -fraction(6, 25), fraction(13, 50)]);
        let (left, right) = bernstein.split(0);
        assert_eq!(left.coefficients, vec![fraction(13, 50), fraction(1, 100), fraction(1, 100)]);
        assert_eq!(right.coefficients, vec![fraction(1, 100), fraction(1, 100), fraction(13, 50)]);
        // Splitting a constant coordinate preserves the exact polynomial.
        let (same_left, same_right) = bernstein.split(1);
        assert_eq!(same_left.coefficients, bernstein.coefficients);
        assert_eq!(same_right.coefficients, bernstein.coefficients);
        let mut sufficient_work = 3;
        assert!(prove_positive(&p, &mut sufficient_work));
        assert_eq!(sufficient_work, 0);
        let mut insufficient_work = 2;
        assert!(!prove_positive(&p, &mut insufficient_work));
        assert_eq!(insufficient_work, 0);
        let mut no_subdivision = 1;
        assert!(!positive_bernstein(bernstein, MAX_DEPTH, &mut no_subdivision));
        assert_eq!(no_subdivision, 0);
        let mut work = MAX_BOXES;
        assert!(!prove_positive(&Polynomial::constant(rat_zero()), &mut work));

        // (x-1/3)² has an exact interior zero, even though no dyadic split
        // corner can land there. A depth bound must never turn it into acceptance.
        let mut nonstrict = Polynomial::zero([2, 0, 0]);
        nonstrict.coefficients = vec![fraction(1, 9), -fraction(2, 3), rat_one()];
        let mut bounded_work = MAX_BOXES;
        assert!(!prove_positive(&nonstrict, &mut bounded_work));
        assert!(bounded_work > 0);
    }
}
