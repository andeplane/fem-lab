//! Quadrature rules on the reference domains: Gauss–Legendre tensor products on the square
//! `[-1,1]²` and cube `[-1,1]³`, and the degree-1/degree-2 rules on the unit triangle and
//! tetrahedron. Every rule is a static table; the element code picks one per reference element.

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
