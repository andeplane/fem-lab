//! Quadrature rules on the reference domains: Gauss–Legendre tensor products on the square
//! `[-1,1]²` and cube `[-1,1]³`, and simplex rules selected for the integral degree. Every rule is a static table.

/// Points (`[ξ, η, ζ]`, unused coordinates zero) and weights of one rule. Weights sum to the
/// reference measure: 4 (square), 8 (cube), 1/2 (triangle), 1/6 (tetrahedron).
pub struct Rule {
    pub points: &'static [[f64; 3]],
    pub weights: &'static [f64],
}

/// 1/√3: the 2-point Gauss–Legendre abscissa.
const G2: f64 = 0.577_350_269_189_625_8;
/// √(3/5): the outer 3-point Gauss–Legendre abscissa.
const G3: f64 = 0.774_596_669_241_483_4;
const W5: f64 = 5.0 / 9.0;
const W8: f64 = 8.0 / 9.0;

const GL1: &[(f64, f64)] = &[(0.0, 2.0)];
const GL2: &[(f64, f64)] = &[(-G2, 1.0), (G2, 1.0)];
const GL3: &[(f64, f64)] = &[(-G3, W5), (0.0, W8), (G3, W5)];

/// One-dimensional Gauss–Legendre `(point, weight)` pairs on `[-1, 1]`, exact to degree
/// `2n − 1`. `n` is clamped to `1..=3`: nothing in the crate needs more, and a table lookup
/// cannot fail.
pub fn gauss_legendre(n: usize) -> &'static [(f64, f64)] {
    match n {
        0 | 1 => GL1,
        2 => GL2,
        _ => GL3,
    }
}

/// 2×2 on the square (degree 3 per direction): quad4.
pub const QUAD_2X2: Rule =
    Rule { points: &[[-G2, -G2, 0.0], [-G2, G2, 0.0], [G2, -G2, 0.0], [G2, G2, 0.0]], weights: &[1.0, 1.0, 1.0, 1.0] };

/// 3×3 on the square (degree 5 per direction): quad8.
pub const QUAD_3X3: Rule = Rule {
    points: &[
        [-G3, -G3, 0.0],
        [-G3, 0.0, 0.0],
        [-G3, G3, 0.0],
        [0.0, -G3, 0.0],
        [0.0, 0.0, 0.0],
        [0.0, G3, 0.0],
        [G3, -G3, 0.0],
        [G3, 0.0, 0.0],
        [G3, G3, 0.0],
    ],
    weights: &[W5 * W5, W5 * W8, W5 * W5, W8 * W5, W8 * W8, W8 * W5, W5 * W5, W5 * W8, W5 * W5],
};

/// 2×2×2 on the cube (degree 3 per direction): hex8.
pub const HEX_2X2X2: Rule = Rule {
    points: &[
        [-G2, -G2, -G2],
        [-G2, -G2, G2],
        [-G2, G2, -G2],
        [-G2, G2, G2],
        [G2, -G2, -G2],
        [G2, -G2, G2],
        [G2, G2, -G2],
        [G2, G2, G2],
    ],
    weights: &[1.0; 8],
};

/// 3×3×3 on the cube (degree 5 per direction): hex20.
pub const HEX_3X3X3: Rule = Rule {
    points: &[
        [-G3, -G3, -G3],
        [-G3, -G3, 0.0],
        [-G3, -G3, G3],
        [-G3, 0.0, -G3],
        [-G3, 0.0, 0.0],
        [-G3, 0.0, G3],
        [-G3, G3, -G3],
        [-G3, G3, 0.0],
        [-G3, G3, G3],
        [0.0, -G3, -G3],
        [0.0, -G3, 0.0],
        [0.0, -G3, G3],
        [0.0, 0.0, -G3],
        [0.0, 0.0, 0.0],
        [0.0, 0.0, G3],
        [0.0, G3, -G3],
        [0.0, G3, 0.0],
        [0.0, G3, G3],
        [G3, -G3, -G3],
        [G3, -G3, 0.0],
        [G3, -G3, G3],
        [G3, 0.0, -G3],
        [G3, 0.0, 0.0],
        [G3, 0.0, G3],
        [G3, G3, -G3],
        [G3, G3, 0.0],
        [G3, G3, G3],
    ],
    weights: &[
        W5 * W5 * W5,
        W5 * W5 * W8,
        W5 * W5 * W5,
        W5 * W8 * W5,
        W5 * W8 * W8,
        W5 * W8 * W5,
        W5 * W5 * W5,
        W5 * W5 * W8,
        W5 * W5 * W5,
        W8 * W5 * W5,
        W8 * W5 * W8,
        W8 * W5 * W5,
        W8 * W8 * W5,
        W8 * W8 * W8,
        W8 * W8 * W5,
        W8 * W5 * W5,
        W8 * W5 * W8,
        W8 * W5 * W5,
        W5 * W5 * W5,
        W5 * W5 * W8,
        W5 * W5 * W5,
        W5 * W8 * W5,
        W5 * W8 * W8,
        W5 * W8 * W5,
        W5 * W5 * W5,
        W5 * W5 * W8,
        W5 * W5 * W5,
    ],
};

/// Centroid rule on the unit triangle (degree 1): tri3.
pub const TRI_1: Rule = Rule { points: &[[1.0 / 3.0, 1.0 / 3.0, 0.0]], weights: &[0.5] };

/// Three interior points on the unit triangle (degree 2): tri6, what Abaqus uses for CPS6.
pub const TRI_3: Rule = Rule {
    points: &[[1.0 / 6.0, 1.0 / 6.0, 0.0], [2.0 / 3.0, 1.0 / 6.0, 0.0], [1.0 / 6.0, 2.0 / 3.0, 0.0]],
    weights: &[1.0 / 6.0, 1.0 / 6.0, 1.0 / 6.0],
};

/// Centroid rule on the unit tetrahedron (degree 1): tet4.
pub const TET_1: Rule = Rule { points: &[[0.25, 0.25, 0.25]], weights: &[1.0 / 6.0] };

const TET_A: f64 = 0.585_410_196_624_968_5;
const TET_B: f64 = 0.138_196_601_125_010_5;

/// Four interior points on the unit tetrahedron (degree 2): tet10, what Abaqus uses for C3D10.
pub const TET_4: Rule = Rule {
    points: &[[TET_A, TET_B, TET_B], [TET_B, TET_A, TET_B], [TET_B, TET_B, TET_A], [TET_B, TET_B, TET_B]],
    weights: &[1.0 / 24.0; 4],
};

// Positive Gauss–Legendre rules on [0, 1]. Collapsing a square/cube onto a simplex
// multiplies the integrand by (1-u) / (1-u)^2(1-v), respectively. The tables below
// are formed at compile time; no runtime quadrature construction or allocation is needed.
const UNIT_GL3: [(f64, f64); 3] = [((1.0 - G3) / 2.0, W5 / 2.0), (0.5, W8 / 2.0), ((1.0 + G3) / 2.0, W5 / 2.0)];
const UNIT_GL5: [(f64, f64); 5] = [
    (0.046_910_077_030_668, 0.118_463_442_528_095),
    (0.230_765_344_947_158_45, 0.239_314_335_249_683_25),
    (0.5, 0.284_444_444_444_444_44),
    (0.769_234_655_052_841_5, 0.239_314_335_249_683_25),
    (0.953_089_922_969_332, 0.118_463_442_528_095),
];

const TRI_9_TABLE: ([[f64; 3]; 9], [f64; 9]) = {
    let mut points = [[0.0; 3]; 9];
    let mut weights = [0.0; 9];
    let mut i = 0;
    while i < 9 {
        let (u, wu) = UNIT_GL3[i / 3];
        let (v, wv) = UNIT_GL3[i % 3];
        points[i] = [u, (1.0 - u) * v, 0.0];
        weights[i] = wu * wv * (1.0 - u);
        i += 1;
    }
    (points, weights)
};

/// Positive collapsed Gauss rule on the unit triangle, exact through total degree 4.
pub const TRI_9: Rule = Rule { points: &TRI_9_TABLE.0, weights: &TRI_9_TABLE.1 };

const TRI_25_TABLE: ([[f64; 3]; 25], [f64; 25]) = {
    let mut points = [[0.0; 3]; 25];
    let mut weights = [0.0; 25];
    let mut i = 0;
    while i < 25 {
        let (u, wu) = UNIT_GL5[i / 5];
        let (v, wv) = UNIT_GL5[i % 5];
        points[i] = [u, (1.0 - u) * v, 0.0];
        weights[i] = wu * wv * (1.0 - u);
        i += 1;
    }
    (points, weights)
};

/// Positive collapsed Gauss rule on the unit triangle, exact through total degree 8.
pub const TRI_25: Rule = Rule { points: &TRI_25_TABLE.0, weights: &TRI_25_TABLE.1 };

const TET_125_TABLE: ([[f64; 3]; 125], [f64; 125]) = {
    let mut points = [[0.0; 3]; 125];
    let mut weights = [0.0; 125];
    let mut i = 0;
    while i < 125 {
        let (u, wu) = UNIT_GL5[i / 25];
        let (v, wv) = UNIT_GL5[(i / 5) % 5];
        let (z, wz) = UNIT_GL5[i % 5];
        points[i] = [u, (1.0 - u) * v, (1.0 - u) * (1.0 - v) * z];
        weights[i] = wu * wv * wz * (1.0 - u) * (1.0 - u) * (1.0 - v);
        i += 1;
    }
    (points, weights)
};

/// Positive collapsed Gauss rule on the unit tetrahedron, exact through total degree 7.
pub const TET_125: Rule = Rule { points: &TET_125_TABLE.0, weights: &TET_125_TABLE.1 };

/// Positive symmetric triangle rule, exact through degree5. Geometry queries use it
/// for quadratic surfaces; the stiffness and physical boundary rules stay unchanged.
/// The six off-centre points form complete barycentric permutation orbits.
const SQRT15: f64 = 3.872_983_346_207_417;
const T7_A: f64 = (6.0 + SQRT15) / 21.0;
const T7_B: f64 = (9.0 - 2.0 * SQRT15) / 21.0;
const T7_C: f64 = (6.0 - SQRT15) / 21.0;
const T7_D: f64 = (9.0 + 2.0 * SQRT15) / 21.0;
const T7_WA: f64 = (155.0 + SQRT15) / 2400.0;
const T7_WC: f64 = (155.0 - SQRT15) / 2400.0;
pub const TRI_7: Rule = Rule {
    points: &[
        [1.0 / 3.0, 1.0 / 3.0, 0.0],
        [T7_A, T7_A, 0.0],
        [T7_A, T7_B, 0.0],
        [T7_B, T7_A, 0.0],
        [T7_C, T7_C, 0.0],
        [T7_C, T7_D, 0.0],
        [T7_D, T7_C, 0.0],
    ],
    weights: &[9.0 / 80.0, T7_WA, T7_WA, T7_WA, T7_WC, T7_WC, T7_WC],
};

const TET_27_TABLE: ([[f64; 3]; 27], [f64; 27]) = {
    let mut points = [[0.0; 3]; 27];
    let mut weights = [0.0; 27];
    let mut i = 0;
    while i < 27 {
        let (u, wu) = UNIT_GL3[i / 9];
        let (v, wv) = UNIT_GL3[(i / 3) % 3];
        let (z, wz) = UNIT_GL3[i % 3];
        points[i] = [u, (1.0 - u) * v, (1.0 - u) * (1.0 - v) * z];
        weights[i] = wu * wv * wz * (1.0 - u) * (1.0 - u) * (1.0 - v);
        i += 1;
    }
    (points, weights)
};

/// Positive collapsed Gauss rule, exact through tetrahedron degree3. Three-point
/// Gauss is exact through degree5 in u, including the collapsed Jacobian (1-u)².
/// This suffices for a Tet10 geometry determinant, which has total degree3.
pub const TET_27: Rule = Rule { points: &TET_27_TABLE.0, weights: &TET_27_TABLE.1 };

#[cfg(test)]
mod geometry_rule_tests {
    use super::*;

    fn factorial(n: usize) -> f64 {
        (1..=n).product::<usize>() as f64
    }

    #[test]
    fn triangle_geometry_rule_has_positive_weights_and_degree_five_exactness() {
        for (&[u, v, _], &weight) in TRI_7.points.iter().zip(TRI_7.weights) {
            assert!(u > 0.0 && v > 0.0 && u + v < 1.0 && weight > 0.0);
        }
        for p in 0..=5 {
            for q in 0..=5 - p {
                let integral: f64 = TRI_7
                    .points
                    .iter()
                    .zip(TRI_7.weights)
                    .map(|(x, w)| w * x[0].powi(p as i32) * x[1].powi(q as i32))
                    .sum();
                let exact = factorial(p) * factorial(q) / factorial(p + q + 2);
                assert!((integral - exact).abs() < 2e-15);
            }
        }
    }

    #[test]
    fn tetrahedron_geometry_rule_has_positive_weights_and_degree_three_exactness() {
        for (&[u, v, z], &weight) in TET_27.points.iter().zip(TET_27.weights) {
            assert!(u > 0.0 && v > 0.0 && z > 0.0 && u + v + z < 1.0 && weight > 0.0);
        }
        for p in 0..=3 {
            for q in 0..=3 - p {
                for r in 0..=3 - p - q {
                    let integral: f64 = TET_27
                        .points
                        .iter()
                        .zip(TET_27.weights)
                        .map(|(x, w)| w * x[0].powi(p as i32) * x[1].powi(q as i32) * x[2].powi(r as i32))
                        .sum();
                    let exact = factorial(p) * factorial(q) * factorial(r) / factorial(p + q + r + 3);
                    assert!((integral - exact).abs() < 2e-15);
                }
            }
        }
    }
}
