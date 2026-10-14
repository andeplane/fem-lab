//! Conservative certificates for the *original* Tet4/Hex8 geometry (#517).
//!
//! Finite f64 coordinates become exact rationals. A Hex8's reference map is
//! trilinear, and its faces are their original bilinear patches, never triangles.
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
        result
    }

    fn scale(&self, factor: &Rational) -> Self {
        Self { degree: self.degree, coefficients: self.coefficients.iter().map(|c| c * factor).collect() }
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
        result
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
        result
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

struct Cell {
    element: u32,
    kind: ElementKind,
    nodes: Vec<u32>,
    points: Vec<R3>,
    map: [Polynomial; 3],
    lo: [f64; 3],
    hi: [f64; 3],
}

impl Cell {
    fn new(mesh: &Mesh, element: u32) -> Self {
        let kind = mesh.kind_of(element);
        let nodes = mesh.elem_nodes(element).to_vec();
        let coordinates: Vec<_> = nodes.iter().map(|&node| mesh.node(node)).collect();
        let points: Vec<_> = coordinates.iter().map(|p| R3::from_vec3(Vec3::new(p[0], p[1], p[2]))).collect();
        let map = std::array::from_fn(|component| {
            let values: Vec<_> = points.iter().map(|p| [&p.x, &p.y, &p.z][component].clone()).collect();
            let mut polynomial = Polynomial::zero([1; 3]);
            if kind == ElementKind::Hex8 {
                for (i, &bits) in HEX_BITS.iter().enumerate() {
                    polynomial.coefficients[index([1; 3], bits)] = values[i].clone();
                }
                // Corner values -> exact tensor power coefficients.
                for axis in 0..3 {
                    for i in 0..8 {
                        if i & (1 << axis) != 0 {
                            let previous = polynomial.coefficients[i ^ (1 << axis)].clone();
                            polynomial.coefficients[i] -= previous;
                        }
                    }
                }
            } else {
                polynomial.coefficients[0] = values[0].clone();
                for axis in 0..3 {
                    polynomial.coefficients[1 << axis] = &values[axis + 1] - &values[0];
                }
            }
            polynomial
        });
        let lo = std::array::from_fn(|k| coordinates.iter().map(|p| p[k]).fold(f64::INFINITY, f64::min));
        let hi = std::array::from_fn(|k| coordinates.iter().map(|p| p[k]).fold(f64::NEG_INFINITY, f64::max));
        Self { element, kind, nodes, points, map, lo, hi }
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
                    let at = [fraction(x, 2), fraction(y, 2), fraction(z, 2)];
                    let sample = std::array::from_fn(|i| std::array::from_fn(|j| jacobian[i][j].evaluate(&at)));
                    if Sign::of_rat(&determinant(&sample)) != Sign::Pos {
                        return Err(ImportedCertificateError::Invalid {
                            elements: vec![self.element],
                            cause: format!("Hex8 has a nonpositive exact Jacobian at reference [{x}/2,{y}/2,{z}/2]"),
                        });
                    }
                }
            }
        }
        let center: [[Rational; 3]; 3] = std::array::from_fn(|i| {
            std::array::from_fn(|j| jacobian[i][j].evaluate(&[fraction(1, 2), fraction(1, 2), fraction(1, 2)]))
        });
        let adjugate: [[Rational; 3]; 3] = std::array::from_fn(|i| {
            std::array::from_fn(|j| {
                &center[(j + 1) % 3][(i + 1) % 3] * &center[(j + 2) % 3][(i + 2) % 3]
                    - &center[(j + 1) % 3][(i + 2) % 3] * &center[(j + 2) % 3][(i + 1) % 3]
            })
        });
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
}

impl ImplicitFace {
    fn new(cell: &Cell, face: usize) -> Self {
        let local = cell.kind.face_nodes(face);
        let origin = cell.points[local[0] as usize].clone();
        let b = cell.points[local[1] as usize].sub(&origin);
        let c = cell.points[*local.last().expect("solid faces have corners") as usize].sub(&origin);
        let normal = b.cross(&c);
        if cell.kind == ElementKind::Tet4 {
            return Self { origin, linear: normal, product: None };
        }
        let d = cell.points[local[2] as usize].sub(&origin).sub(&b).sub(&c);
        let u = c.cross(&d);
        let determinant = b.dot(&u);
        if rat_is_zero(&determinant) {
            Self { origin, linear: normal, product: None }
        } else {
            Self { origin, linear: normal.scale(&determinant), product: Some((u, d.cross(&b))) }
        }
    }

    fn evaluate(&self, point: &R3) -> Rational {
        let relative = point.sub(&self.origin);
        let linear = self.linear.dot(&relative);
        match &self.product {
            Some((u, v)) => linear - u.dot(&relative) * v.dot(&relative),
            None => linear,
        }
    }

    fn compose(&self, map: &[Polynomial; 3]) -> Polynomial {
        let origin = [&self.origin.x, &self.origin.y, &self.origin.z];
        let relative: [Polynomial; 3] = std::array::from_fn(|k| map[k].sub(&Polynomial::constant(origin[k].clone())));
        let linear = linear_combination(&relative, &self.linear);
        match &self.product {
            Some((u, v)) => linear.sub(&linear_combination(&relative, u).mul(&linear_combination(&relative, v))),
            None => linear,
        }
    }
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
    if cell.kind == ElementKind::Tet4 {
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
        if zero.is_empty() {
            if !prove_positive(&polynomial, remaining) {
                return None;
            }
        } else {
            // A zero entity must be one reference face, edge or vertex, not a
            // diagonal, disjoint corners, or an approximate coordinate contact.
            let fixed: Vec<_> = (0..3)
                .filter_map(|axis| {
                    let bit = HEX_BITS[zero[0]][axis];
                    zero.iter().all(|&i| HEX_BITS[i][axis] == bit).then_some((axis, bit))
                })
                .collect();
            let expected: Vec<_> =
                (0..8).filter(|&i| fixed.iter().all(|&(axis, bit)| HEX_BITS[i][axis] == bit)).collect();
            if expected != zero {
                return None;
            }
            for &(axis, bit) in &fixed {
                if bit == 1 {
                    polynomial = polynomial.reverse_axis(axis);
                }
            }
            // After reversing fixed coordinates, the expected entity is u=v=...
            // =0. Exact p=u*H1+v*H2(+w*H3), each H>0, proves precisely that
            // zero set over the closed cube, including boundary tangencies.
            let mut quotients = Vec::with_capacity(fixed.len());
            for &(axis, _) in &fixed {
                let (quotient, remainder) = polynomial.take_factor(axis);
                quotients.push(quotient);
                polynomial = remainder;
            }
            if !polynomial.coefficients.iter().all(rat_is_zero) {
                return None;
            }
            if !quotients.iter().all(|quotient| prove_positive(quotient, remaining)) {
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

fn labelled_entity_matches(a: &Cell, b: &Cell, common: &[u32]) -> bool {
    match common.len() {
        1 => true,
        2 => [a, b].iter().all(|cell| {
            cell.kind.edges().iter().any(|&[i, j]| {
                let mut edge = [cell.nodes[i as usize], cell.nodes[j as usize]];
                edge.sort_unstable();
                edge == common
            })
        }),
        3 => a.kind == ElementKind::Tet4 && b.kind == ElementKind::Tet4,
        4 => {
            let cycles: Vec<_> = [a, b]
                .iter()
                .filter_map(|cell| {
                    (0..cell.kind.n_faces()).find_map(|face| {
                        let nodes: Vec<_> =
                            cell.kind.face_nodes(face).iter().map(|&i| cell.nodes[i as usize]).collect();
                        let mut sorted = nodes.clone();
                        sorted.sort_unstable();
                        (sorted == common).then_some(nodes)
                    })
                })
                .collect();
            if cycles.len() != 2 {
                return false;
            }
            let edge_sets: Vec<_> = cycles
                .iter()
                .map(|cycle| {
                    let mut edges: Vec<_> = (0..4)
                        .map(|i| {
                            let mut edge = [cycle[i], cycle[(i + 1) % 4]];
                            edge.sort_unstable();
                            edge
                        })
                        .collect();
                    edges.sort_unstable();
                    edges
                })
                .collect();
            edge_sets[0] == edge_sets[1]
        }
        _ => false,
    }
}

fn certify_pair(a: &Cell, b: &Cell) -> bool {
    let mut common: Vec<_> = a.nodes.iter().filter(|node| b.nodes.contains(node)).copied().collect();
    common.sort_unstable();
    let mut zero_a = a.nodes.clone();
    let mut zero_b = b.nodes.clone();
    zero_a.sort_unstable();
    zero_b.sort_unstable();
    let mut remaining = MAX_BOXES;
    for owner in [a, b] {
        for face_index in 0..owner.kind.n_faces() {
            let face = ImplicitFace::new(owner, face_index);
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
                if zero_a.is_empty()
                    || zero_b.is_empty()
                    || (zero_a == common && zero_b == common && labelled_entity_matches(a, b, &common))
                {
                    return true;
                }
            }
        }
    }
    false
}

/// Certify Tet4/Hex8 original geometry, or reject without mutating the mesh.
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
/// Each pair gets at most 4096 proof boxes, split at most 12 times in fixed xyz
/// order. Broad-phase memory is linear; worst-case pair work remains quadratic.
pub fn certify_imported_geometry(mesh: &Mesh) -> Result<(), ImportedCertificateError> {
    let mut cells = Vec::with_capacity(mesh.n_elems());
    for element in 0..mesh.n_elems() as u32 {
        let kind = mesh.kind_of(element);
        if kind != ElementKind::Tet4 && kind != ElementKind::Hex8 {
            return Err(ImportedCertificateError::Inconclusive {
                elements: vec![element],
                cause: "original-geometry certificate supports only Tet4 and Hex8".into(),
            });
        }
        let cell = Cell::new(mesh, element);
        cell.certify_injective()?;
        cells.push(cell);
    }
    cells.sort_by(|a, b| a.lo[0].total_cmp(&b.lo[0]).then(a.element.cmp(&b.element)));
    let mut active: Vec<usize> = Vec::new();
    for (i, cell) in cells.iter().enumerate() {
        active.retain(|&j| cells[j].hi[0] >= cell.lo[0]);
        for &j in &active {
            let other = &cells[j];
            if (1..3).any(|k| other.hi[k] < cell.lo[k] || cell.hi[k] < other.lo[k]) {
                continue;
            }
            let elements = vec![cell.element.min(other.element), cell.element.max(other.element)];
            if cell.kind == ElementKind::Tet4 && other.kind == ElementKind::Tet4 {
                if !crate::mesh_validation::tet_pair_is_conforming(mesh, cell.element, other.element) {
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
