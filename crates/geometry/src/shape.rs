//! The Shape tree: primitives, sketches turned into bodies, booleans and transforms.
//! Serialisable, so a Command can carry one; evaluated to a `Solid` by `solid.rs`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::imported::MAX_TRIANGLES;
use crate::sketch::Sketch;
use crate::GeomError;

/// Default number of facets around a circle for cylinders, spheres and revolutions.
pub const DEFAULT_SEGMENTS: u32 = 32;

/// A boolean over shapes of different dimensions has no meaning.
const DIM_MIX: &str = "cannot combine 1D line members, 2D sheets and 3D solids";

/// Scale, then rotate about x, y, z (degrees, in that order), then translate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Affine3 {
    #[serde(default)]
    pub translate: [f64; 3],
    /// Rotation angles about the x, y and z axes in degrees, applied in that order.
    #[serde(default)]
    pub rotate: [f64; 3],
    #[serde(default = "ones")]
    pub scale: [f64; 3],
}

fn ones() -> [f64; 3] {
    [1.0, 1.0, 1.0]
}

impl Default for Affine3 {
    fn default() -> Affine3 {
        Affine3 { translate: [0.0; 3], rotate: [0.0; 3], scale: ones() }
    }
}

impl Affine3 {
    pub fn translation(t: [f64; 3]) -> Affine3 {
        Affine3 { translate: t, ..Default::default() }
    }
    fn rotation_matrix(&self) -> [[f64; 3]; 3] {
        let d = std::f64::consts::PI / 180.0;
        let (sx, cx) = (libm::sin(self.rotate[0] * d), libm::cos(self.rotate[0] * d));
        let (sy, cy) = (libm::sin(self.rotate[1] * d), libm::cos(self.rotate[1] * d));
        let (sz, cz) = (libm::sin(self.rotate[2] * d), libm::cos(self.rotate[2] * d));
        let rx = [[1.0, 0.0, 0.0], [0.0, cx, -sx], [0.0, sx, cx]];
        let ry = [[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]];
        let rz = [[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]];
        mat_mul(&rz, &mat_mul(&ry, &rx))
    }
    /// Forward map of a point.
    pub fn apply(&self, p: [f64; 3]) -> [f64; 3] {
        let s = [p[0] * self.scale[0], p[1] * self.scale[1], p[2] * self.scale[2]];
        let r = mat_vec(&self.rotation_matrix(), s);
        [r[0] + self.translate[0], r[1] + self.translate[1], r[2] + self.translate[2]]
    }
    /// Inverse map of a point.
    pub fn inverse(&self, p: [f64; 3]) -> [f64; 3] {
        let q = [p[0] - self.translate[0], p[1] - self.translate[1], p[2] - self.translate[2]];
        let m = self.rotation_matrix();
        let mt = [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
        let r = mat_vec(&mt, q);
        [r[0] / self.scale[0], r[1] / self.scale[1], r[2] / self.scale[2]]
    }
    pub fn validate(&self) -> Result<(), GeomError> {
        if self.scale.iter().any(|s| *s <= 0.0 || !s.is_finite()) {
            return Err(GeomError(format!("scale factors must be positive, got {:?}", self.scale)));
        }
        if self.translate.iter().chain(self.rotate.iter()).any(|v| !v.is_finite()) {
            return Err(GeomError("transform has a non-finite component".into()));
        }
        Ok(())
    }
}

fn mat_mul(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut c = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                c[i][j] += a[i][k] * b[k][j];
            }
        }
    }
    c
}

fn mat_vec(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

/// A shape: a primitive, a sketch made into a body, or a boolean/transform of shapes.
/// All lengths are SI metres, angles degrees.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Shape {
    /// Axis-aligned box from the origin to `size`. Faces are tagged `xmin … zmax`.
    Box { size: [f64; 3] },
    /// Cylinder along z from z = 0 to `height`, centred on the z axis. Faces: `side`, `bottom`, `top`.
    Cylinder {
        radius: f64,
        height: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        segments: Option<u32>,
    },
    /// Sphere centred at the origin. One face: `surface`.
    Sphere {
        radius: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        segments: Option<u32>,
    },
    /// A 2D body in the xy plane (plane stress/strain or axisymmetric with x = r, y = z).
    /// Its boundary edges are the "faces", tagged by segment (`edge0 …`, `hole0.edge0 …`, or the
    /// segment's own tag).
    Sheet { sketch: Sketch },
    /// The sketch extruded along z from 0 to `height`. Faces: the segment tags plus `bottom`, `top`.
    Extrude { sketch: Sketch, height: f64 },
    /// The sketch (x = radius ≥ 0, y = axial) revolved about the y axis, which becomes the
    /// solid's z axis, through `angle` degrees starting at +x. Faces: the segment tags, plus
    /// `theta0` and `theta1` when the angle is below 360.
    Revolve {
        sketch: Sketch,
        angle: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        segments: Option<u32>,
    },
    /// Union of shapes.
    Union { shapes: Vec<Shape> },
    /// `from` minus every shape in `cut`.
    Subtract { from: Box<Shape>, cut: Vec<Shape> },
    /// Intersection of shapes.
    Intersect { shapes: Vec<Shape> },
    /// A shape moved by an affine transform.
    Transform { shape: Box<Shape>, at: Affine3 },
    /// A named sub-shape: its faces are tagged `<name>.<tag>`.
    Named { name: String, shape: Box<Shape> },
    /// Straight line members between joints: a truss or a frame. `points` are the joints,
    /// `members` index pairs into them, and each member is cut into `divisions` elements. It
    /// has no volume and no surface, so it never becomes a [`crate::Solid`]; the line mesher
    /// is its own geometry. Its node sets are `p0 … pN`, one per joint.
    Polyline { points: Vec<[f64; 3]>, members: Vec<[u32; 2]>, divisions: u32 },
    /// A triangle mesh read from a file (`geometry.import`), welded into a solid by the
    /// geometry kernel. Its faces are patches of triangles that meet more smoothly than
    /// `feature_angle`, tagged `face0`, `face1`, … largest area first.
    Mesh {
        /// Vertex positions in metres.
        positions: Vec<[f64; 3]>,
        /// Triangles as vertex indices, counter-clockwise seen from outside.
        triangles: Vec<[u32; 3]>,
        /// Dihedral angle in degrees above which an edge splits two face patches; 30 by default.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        feature_angle: Option<f64>,
        /// Collapse mesh features smaller than this many metres before use.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        simplify_below: Option<f64>,
    },
}

impl Shape {
    /// Whether this Body came from an imported triangle mesh, allowing a host to wrap that
    /// mesh in a world-space transform without losing its import-specific metadata.
    pub fn is_imported(&self) -> bool {
        match self {
            Shape::Mesh { .. } => true,
            Shape::Transform { shape, .. } | Shape::Named { shape, .. } => shape.is_imported(),
            _ => false,
        }
    }

    /// 1 for line members, 2 for sheets (and booleans of sheets), 3 otherwise.
    pub fn dim(&self) -> usize {
        match self {
            Shape::Polyline { .. } => 1,
            Shape::Sheet { .. } => 2,
            Shape::Union { shapes } | Shape::Intersect { shapes } => shapes.first().map_or(3, Shape::dim),
            Shape::Subtract { from, .. } => from.dim(),
            Shape::Transform { shape, .. } | Shape::Named { shape, .. } => shape.dim(),
            _ => 3,
        }
    }

    pub fn validate(&self) -> Result<(), GeomError> {
        let pos = |v: f64, what: &str| {
            if v > 0.0 && v.is_finite() {
                Ok(())
            } else {
                Err(GeomError(format!("{what} must be positive, got {v}")))
            }
        };
        let segs = |s: Option<u32>| {
            if s.unwrap_or(DEFAULT_SEGMENTS) < 3 {
                Err(GeomError("segments must be at least 3".into()))
            } else {
                Ok(())
            }
        };
        match self {
            Shape::Box { size } => {
                for (i, s) in size.iter().enumerate() {
                    pos(*s, &format!("size[{i}]"))?;
                }
                Ok(())
            }
            Shape::Cylinder { radius, height, segments } => {
                pos(*radius, "radius")?;
                pos(*height, "height")?;
                segs(*segments)
            }
            Shape::Sphere { radius, segments } => {
                pos(*radius, "radius")?;
                segs(*segments)
            }
            Shape::Sheet { sketch } => sketch.validate(),
            Shape::Extrude { sketch, height } => {
                sketch.validate()?;
                pos(*height, "height")
            }
            Shape::Revolve { sketch, angle, segments } => {
                sketch.validate()?;
                if !(*angle > 0.0 && *angle <= 360.0) {
                    return Err(GeomError(format!("angle must be in (0, 360] degrees, got {angle}")));
                }
                // validate() above guarantees bbox() succeeds
                let (lo, _) = sketch.bbox().unwrap_or_default();
                if lo[0] < -1e-12 {
                    return Err(GeomError(format!(
                        "a revolved sketch must have x ≥ 0 (x is the radius); min x is {}",
                        lo[0]
                    )));
                }
                segs(*segments)
            }
            Shape::Union { shapes } | Shape::Intersect { shapes } => {
                if shapes.is_empty() {
                    return Err(GeomError("a boolean needs at least one shape".into()));
                }
                let d = shapes[0].dim();
                for s in shapes {
                    s.validate()?;
                    if s.dim() != d {
                        return Err(GeomError(DIM_MIX.into()));
                    }
                }
                Ok(())
            }
            Shape::Subtract { from, cut } => {
                from.validate()?;
                for c in cut {
                    c.validate()?;
                    if c.dim() != from.dim() {
                        return Err(GeomError(DIM_MIX.into()));
                    }
                }
                Ok(())
            }
            Shape::Transform { shape, at } => {
                at.validate()?;
                shape.validate()
            }
            Shape::Named { name, shape } => {
                if name.is_empty() || name.contains('.') || name.contains(char::is_whitespace) {
                    return Err(GeomError(format!("'{name}' is not a valid name (no dots or spaces)")));
                }
                shape.validate()
            }
            Shape::Polyline { points, members, divisions } => crate::mesher::line::check(points, members, *divisions),
            Shape::Mesh { positions, triangles, feature_angle, simplify_below } => {
                if triangles.len() < 4 {
                    return Err(GeomError(format!(
                        "an imported mesh needs at least 4 triangles to bound a solid, got {}",
                        triangles.len()
                    )));
                }
                if triangles.len() > MAX_TRIANGLES {
                    return Err(GeomError(format!(
                        "an imported mesh is limited to {MAX_TRIANGLES} triangles, got {}; decimate it first",
                        triangles.len()
                    )));
                }
                for (i, p) in positions.iter().enumerate() {
                    if p.iter().any(|c| !c.is_finite()) {
                        return Err(GeomError(format!("vertex {i} has a non-finite coordinate: {p:?}")));
                    }
                }
                for (i, t) in triangles.iter().enumerate() {
                    for v in t {
                        if *v as usize >= positions.len() {
                            return Err(GeomError(format!(
                                "triangle {i} refers to vertex {v}, but the mesh has {} vertices",
                                positions.len()
                            )));
                        }
                    }
                    let n = crate::solid::tri_normal(
                        positions[t[0] as usize],
                        positions[t[1] as usize],
                        positions[t[2] as usize],
                    );
                    if n == [0.0; 3] || n.iter().any(|c| !c.is_finite()) {
                        return Err(GeomError(format!("triangle {i} has zero or non-finite area")));
                    }
                }
                if let Some(a) = feature_angle {
                    if !(*a > 0.0 && *a < 180.0) {
                        return Err(GeomError(format!("featureAngle must be in (0, 180) degrees, got {a}")));
                    }
                }
                if let Some(s) = simplify_below {
                    if !(*s >= 0.0 && s.is_finite()) {
                        return Err(GeomError(format!("simplifyBelow must be zero or positive, got {s}")));
                    }
                }
                Ok(())
            }
        }
    }

    /// Analytic point containment on the tree (curved primitives are exact circles here,
    /// while the evaluated solid is faceted).
    pub fn contains(&self, p: [f64; 3]) -> Result<bool, GeomError> {
        Ok(match self {
            Shape::Box { size } => (0..3).all(|k| p[k] >= 0.0 && p[k] <= size[k]),
            Shape::Cylinder { radius, height, .. } => {
                p[2] >= 0.0 && p[2] <= *height && p[0] * p[0] + p[1] * p[1] <= radius * radius
            }
            Shape::Sphere { radius, .. } => p[0] * p[0] + p[1] * p[1] + p[2] * p[2] <= radius * radius,
            Shape::Sheet { sketch } => sketch.contains([p[0], p[1]])?,
            Shape::Extrude { sketch, height } => p[2] >= 0.0 && p[2] <= *height && sketch.contains([p[0], p[1]])?,
            Shape::Revolve { sketch, angle, .. } => {
                let r = libm::hypot(p[0], p[1]);
                let mut th = libm::atan2(p[1], p[0]);
                if th < 0.0 {
                    th += std::f64::consts::TAU;
                }
                th <= angle.to_radians() + 1e-12 && sketch.contains([r, p[2]])?
            }
            Shape::Union { shapes } => {
                for s in shapes {
                    if s.contains(p)? {
                        return Ok(true);
                    }
                }
                false
            }
            Shape::Intersect { shapes } => {
                for s in shapes {
                    if !s.contains(p)? {
                        return Ok(false);
                    }
                }
                true
            }
            Shape::Subtract { from, cut } => {
                if !from.contains(p)? {
                    return Ok(false);
                }
                for c in cut {
                    if c.contains(p)? {
                        return Ok(false);
                    }
                }
                true
            }
            Shape::Transform { shape, at } => shape.contains(at.inverse(p))?,
            Shape::Named { shape, .. } => shape.contains(p)?,
            // A member is a curve: it has no interior for a point to be inside of.
            Shape::Polyline { .. } => false,
            // An imported mesh has no analytic form; `Solid` ray-casts the evaluated
            // manifold instead, which is the only place the answer exists.
            Shape::Mesh { .. } => {
                return Err(GeomError("an imported mesh is only contained-tested as an evaluated Solid".into()))
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: [f64; 3], b: [f64; 3]) -> bool {
        (0..3).all(|k| (a[k] - b[k]).abs() < 1e-12)
    }

    #[test]
    fn affine_round_trips_and_validates() {
        let a = Affine3 { translate: [1.0, 2.0, 3.0], rotate: [30.0, 45.0, 60.0], scale: [2.0, 3.0, 4.0] };
        let p = [0.3, -0.7, 1.9];
        assert!(close(a.inverse(a.apply(p)), p));
        assert!(close(Affine3::default().apply(p), p));
        let t = Affine3::translation([1.0, 0.0, 0.0]);
        assert_eq!(t.apply([0.0, 0.0, 0.0]), [1.0, 0.0, 0.0]);
        // rotate 90° about z maps x to y
        let rz = Affine3 { rotate: [0.0, 0.0, 90.0], ..Default::default() };
        assert!(close(rz.apply([1.0, 0.0, 0.0]), [0.0, 1.0, 0.0]));
        let rx = Affine3 { rotate: [90.0, 0.0, 0.0], ..Default::default() };
        assert!(close(rx.apply([0.0, 1.0, 0.0]), [0.0, 0.0, 1.0]));
        let ry = Affine3 { rotate: [0.0, 90.0, 0.0], ..Default::default() };
        assert!(close(ry.apply([0.0, 0.0, 1.0]), [1.0, 0.0, 0.0]));
        assert!(Affine3 { scale: [0.0, 1.0, 1.0], ..Default::default() }.validate().is_err());
        assert!(Affine3 { translate: [f64::NAN, 0.0, 0.0], ..Default::default() }.validate().is_err());
        let j = serde_json::to_string(&Affine3::translation([1.0, 0.0, 0.0])).unwrap();
        assert_eq!(j, r#"{"translate":[1.0,0.0,0.0],"rotate":[0.0,0.0,0.0],"scale":[1.0,1.0,1.0]}"#);
        let back: Affine3 = serde_json::from_str(r#"{"translate":[1,0,0]}"#).unwrap();
        assert_eq!(back.scale, [1.0, 1.0, 1.0]);
    }

    #[test]
    fn dims_and_contains() {
        let b = Shape::Box { size: [1.0, 2.0, 3.0] };
        assert_eq!(b.dim(), 3);
        assert!(b.contains([0.5, 1.0, 2.9]).unwrap());
        assert!(!b.contains([1.5, 1.0, 2.9]).unwrap());
        let c = Shape::Cylinder { radius: 1.0, height: 2.0, segments: None };
        assert!(c.contains([0.5, 0.5, 1.0]).unwrap());
        assert!(!c.contains([0.9, 0.9, 1.0]).unwrap());
        assert!(!c.contains([0.0, 0.0, 2.5]).unwrap());
        let s = Shape::Sphere { radius: 1.0, segments: Some(16) };
        assert!(s.contains([0.5, 0.5, 0.5]).unwrap());
        assert!(!s.contains([0.9, 0.9, 0.0]).unwrap());
        let sheet = Shape::Sheet { sketch: Sketch::rect(2.0, 1.0) };
        assert_eq!(sheet.dim(), 2);
        assert!(sheet.contains([1.0, 0.5, 7.0]).unwrap());
        let ex = Shape::Extrude { sketch: Sketch::rect(2.0, 1.0), height: 3.0 };
        assert!(ex.contains([1.0, 0.5, 2.0]).unwrap());
        assert!(!ex.contains([1.0, 0.5, 3.5]).unwrap());
        // quarter revolve of a unit square at r in [1,2]
        let sk = Shape::Transform {
            shape: Box::new(Shape::Sheet { sketch: Sketch::rect(1.0, 1.0) }),
            at: Affine3::translation([1.0, 0.0, 0.0]),
        };
        let _ = sk;
        let rect = Sketch {
            outer: vec![
                crate::sketch::Segment::Line { to: [2.0, 0.0], tag: None },
                crate::sketch::Segment::Line { to: [2.0, 1.0], tag: None },
                crate::sketch::Segment::Line { to: [1.0, 1.0], tag: None },
                crate::sketch::Segment::Line { to: [1.0, 0.0], tag: None },
            ],
            holes: vec![],
        };
        let rv = Shape::Revolve { sketch: rect.clone(), angle: 90.0, segments: None };
        assert!(rv.contains([1.0, 1.0, 0.5]).unwrap()); // r = 1.41, θ = 45°
        assert!(!rv.contains([-1.0, 1.0, 0.5]).unwrap()); // θ = 135°
        assert!(!rv.contains([0.5, 0.0, 0.5]).unwrap()); // r too small
        let full = Shape::Revolve { sketch: rect.clone(), angle: 360.0, segments: None };
        assert!(full.contains([-1.0, 1.0, 0.5]).unwrap());
        assert!(full.contains([0.0, -1.5, 0.5]).unwrap());
        assert!(!rv.contains([0.0, -1.5, 0.5]).unwrap());
        let u = Shape::Union {
            shapes: vec![
                b.clone(),
                Shape::Transform { shape: Box::new(b.clone()), at: Affine3::translation([5.0, 0.0, 0.0]) },
            ],
        };
        assert_eq!(u.dim(), 3);
        assert!(u.contains([5.5, 1.0, 1.0]).unwrap());
        assert!(!u.contains([3.0, 1.0, 1.0]).unwrap());
        let i = Shape::Intersect {
            shapes: vec![
                b.clone(),
                Shape::Transform { shape: Box::new(b.clone()), at: Affine3::translation([0.5, 0.0, 0.0]) },
            ],
        };
        assert!(i.contains([0.75, 1.0, 1.0]).unwrap());
        assert!(!i.contains([0.25, 1.0, 1.0]).unwrap());
        let sub = Shape::Subtract { from: Box::new(b.clone()), cut: vec![c.clone()] };
        assert!(!sub.contains([0.2, 0.2, 1.0]).unwrap());
        assert!(sub.contains([0.9, 1.9, 1.0]).unwrap());
        assert!(!sub.contains([5.0, 0.0, 0.0]).unwrap());
        let named = Shape::Named { name: "beam".into(), shape: Box::new(b.clone()) };
        assert_eq!(named.dim(), 3);
        assert!(named.contains([0.5, 0.5, 0.5]).unwrap());
        // A line body is a curve: dimension 1, with no interior for a point to be inside of.
        let line = Shape::Polyline { points: vec![[0.0; 3], [1.0, 0.0, 0.0]], members: vec![[0, 1]], divisions: 2 };
        assert_eq!(line.dim(), 1);
        assert!(!line.contains([0.5, 0.0, 0.0]).unwrap());
        assert_eq!(Shape::Union { shapes: vec![] }.dim(), 3);
        assert_eq!(Shape::Subtract { from: Box::new(sheet.clone()), cut: vec![] }.dim(), 2);
        let bad = Shape::Sheet { sketch: Sketch { outer: vec![], holes: vec![] } };
        assert!(bad.contains([0.0, 0.0, 0.0]).is_err());
        let bad_ex = Shape::Extrude { sketch: Sketch { outer: vec![], holes: vec![] }, height: 1.0 };
        assert!(bad_ex.contains([0.0, 0.0, 0.5]).is_err());
        let bad_rv = Shape::Revolve { sketch: Sketch { outer: vec![], holes: vec![] }, angle: 90.0, segments: None };
        assert!(bad_rv.contains([1.0, 0.0, 0.5]).is_err());
        // errors propagate through every composite node
        let good = Shape::Box { size: [1.0; 3] };
        assert!(Shape::Union { shapes: vec![bad.clone()] }.contains([0.0; 3]).is_err());
        assert!(Shape::Intersect { shapes: vec![bad.clone()] }.contains([0.0; 3]).is_err());
        assert!(Shape::Subtract { from: Box::new(bad.clone()), cut: vec![] }.contains([0.0; 3]).is_err());
        assert!(Shape::Subtract { from: Box::new(good.clone()), cut: vec![bad.clone()] }.contains([0.5; 3]).is_err());
        assert!(Shape::Transform { shape: Box::new(bad.clone()), at: Affine3::default() }.contains([0.0; 3]).is_err());
        assert!(Shape::Named { name: "n".into(), shape: Box::new(bad.clone()) }.contains([0.0; 3]).is_err());
    }

    /// The unit cube as a triangle soup, wound counter-clockwise seen from outside.
    fn cube_soup() -> (Vec<[f64; 3]>, Vec<[u32; 3]>) {
        let positions = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [1.0, 1.0, 1.0],
            [0.0, 1.0, 1.0],
        ];
        let quads: [[u32; 4]; 6] = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
        (positions, quads.iter().flat_map(|q| [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]).collect())
    }

    #[test]
    fn an_imported_mesh_validates_its_soup_and_has_no_analytic_containment() {
        let (positions, triangles) = cube_soup();
        let cube = Shape::Mesh {
            positions: positions.clone(),
            triangles: triangles.clone(),
            feature_angle: None,
            simplify_below: None,
        };
        assert_eq!(cube.dim(), 3);
        assert!(cube.validate().is_ok());
        assert!(cube.contains([0.5; 3]).unwrap_err().0.contains("evaluated Solid"));
        let with = |p: Vec<[f64; 3]>, t: Vec<[u32; 3]>, angle: Option<f64>, simplify: Option<f64>| {
            Shape::Mesh { positions: p, triangles: t, feature_angle: angle, simplify_below: simplify }
                .validate()
                .unwrap_err()
                .0
        };
        assert!(with(positions.clone(), triangles[..3].to_vec(), None, None).contains("at least 4 triangles"));
        assert!(with(positions.clone(), vec![[0, 1, 2]; MAX_TRIANGLES + 1], None, None).contains("limited to"));
        let mut nan = positions.clone();
        nan[2][1] = f64::NAN;
        assert!(with(nan, triangles.clone(), None, None).contains("vertex 2 has a non-finite coordinate"));
        let mut oob = triangles.clone();
        oob[5][2] = 99;
        assert!(with(positions.clone(), oob, None, None).contains("triangle 5 refers to vertex 99"));
        let mut flat = triangles.clone();
        flat[7] = [1, 1, 2];
        assert!(with(positions.clone(), flat, None, None).contains("triangle 7 has zero or non-finite area"));
        let huge = vec![[0.0; 3], [1e300, 0.0, 0.0], [0.0, 1e300, 0.0], [0.0, 0.0, 1.0]];
        let big = vec![[0, 1, 2], [0, 1, 3], [1, 2, 3], [0, 2, 3]];
        assert!(with(huge, big, None, None).contains("triangle 0 has zero or non-finite area"));
        assert!(with(positions.clone(), triangles.clone(), Some(0.0), None).contains("featureAngle"));
        assert!(with(positions.clone(), triangles.clone(), Some(180.0), None).contains("featureAngle"));
        assert!(with(positions.clone(), triangles.clone(), None, Some(-1.0)).contains("simplifyBelow"));
        assert!(with(positions.clone(), triangles.clone(), None, Some(f64::NAN)).contains("simplifyBelow"));
        let good = Shape::Mesh { positions, triangles, feature_angle: Some(45.0), simplify_below: Some(0.0) };
        assert!(good.validate().is_ok());
        assert!(serde_json::to_string(&good).unwrap().starts_with(r#"{"kind":"mesh","positions":"#));
    }

    #[test]
    fn validation() {
        assert!(Shape::Box { size: [1.0, 0.0, 1.0] }.validate().unwrap_err().0.contains("size[1]"));
        // A Polyline's validation is the line mesher's, so both name the same cause.
        let line = Shape::Polyline { points: vec![[0.0; 3], [1.0, 0.0, 0.0]], members: vec![[0, 1]], divisions: 1 };
        assert!(line.validate().is_ok());
        let short = Shape::Polyline { points: vec![[0.0; 3]], members: vec![[0, 1]], divisions: 1 };
        assert!(short.validate().unwrap_err().0.contains("at least 2 points"));
        assert!(Shape::Cylinder { radius: -1.0, height: 1.0, segments: None }.validate().is_err());
        assert!(Shape::Cylinder { radius: 1.0, height: 0.0, segments: None }.validate().is_err());
        assert!(Shape::Cylinder { radius: 1.0, height: 1.0, segments: Some(2) }.validate().is_err());
        assert!(Shape::Cylinder { radius: 1.0, height: 1.0, segments: Some(8) }.validate().is_ok());
        assert!(Shape::Sphere { radius: f64::INFINITY, segments: None }.validate().is_err());
        assert!(Shape::Sphere { radius: 1.0, segments: Some(1) }.validate().is_err());
        assert!(Shape::Sphere { radius: 1.0, segments: None }.validate().is_ok());
        assert!(Shape::Sheet { sketch: Sketch::rect(1.0, 1.0) }.validate().is_ok());
        assert!(Shape::Extrude { sketch: Sketch::rect(1.0, 1.0), height: -1.0 }.validate().is_err());
        assert!(Shape::Extrude { sketch: Sketch { outer: vec![], holes: vec![] }, height: 1.0 }.validate().is_err());
        assert!(Shape::Revolve { sketch: Sketch::rect(1.0, 1.0), angle: 0.0, segments: None }.validate().is_err());
        assert!(Shape::Revolve { sketch: Sketch::rect(1.0, 1.0), angle: 361.0, segments: None }.validate().is_err());
        assert!(Shape::Revolve { sketch: Sketch::rect(1.0, 1.0), angle: 90.0, segments: Some(2) }.validate().is_err());
        assert!(Shape::Revolve { sketch: Sketch::rect(1.0, 1.0), angle: 90.0, segments: None }.validate().is_ok());
        assert!(Shape::Revolve { sketch: Sketch { outer: vec![], holes: vec![] }, angle: 90.0, segments: None }
            .validate()
            .is_err());
        let neg = Shape::Transform {
            shape: Box::new(Shape::Sheet { sketch: Sketch::rect(1.0, 1.0) }),
            at: Affine3::translation([-2.0, 0.0, 0.0]),
        };
        let _ = neg;
        let negx = Sketch {
            outer: vec![
                crate::sketch::Segment::Line { to: [1.0, 0.0], tag: None },
                crate::sketch::Segment::Line { to: [1.0, 1.0], tag: None },
                crate::sketch::Segment::Line { to: [-1.0, 1.0], tag: None },
                crate::sketch::Segment::Line { to: [-1.0, 0.0], tag: None },
            ],
            holes: vec![],
        };
        assert!(Shape::Revolve { sketch: negx, angle: 90.0, segments: None }
            .validate()
            .unwrap_err()
            .0
            .contains("x ≥ 0"));
        assert!(Shape::Union { shapes: vec![] }.validate().is_err());
        let b = Shape::Box { size: [1.0; 3] };
        let sheet = Shape::Sheet { sketch: Sketch::rect(1.0, 1.0) };
        assert!(Shape::Union { shapes: vec![b.clone(), sheet.clone()] }.validate().unwrap_err().0.contains("2D"));
        assert!(Shape::Union { shapes: vec![b.clone(), Shape::Box { size: [0.0; 3] }] }.validate().is_err());
        assert!(Shape::Intersect { shapes: vec![b.clone(), b.clone()] }.validate().is_ok());
        assert!(Shape::Subtract { from: Box::new(b.clone()), cut: vec![sheet.clone()] }.validate().is_err());
        assert!(Shape::Subtract { from: Box::new(b.clone()), cut: vec![Shape::Box { size: [0.0; 3] }] }
            .validate()
            .is_err());
        assert!(Shape::Subtract { from: Box::new(Shape::Box { size: [0.0; 3] }), cut: vec![] }.validate().is_err());
        assert!(Shape::Subtract { from: Box::new(b.clone()), cut: vec![b.clone()] }.validate().is_ok());
        assert!(Shape::Transform { shape: Box::new(b.clone()), at: Affine3 { scale: [0.0; 3], ..Default::default() } }
            .validate()
            .is_err());
        assert!(Shape::Transform { shape: Box::new(b.clone()), at: Affine3::default() }.validate().is_ok());
        assert!(Shape::Named { name: "a.b".into(), shape: Box::new(b.clone()) }.validate().is_err());
        assert!(Shape::Named { name: "".into(), shape: Box::new(b.clone()) }.validate().is_err());
        assert!(Shape::Named { name: "ok".into(), shape: Box::new(b.clone()) }.validate().is_ok());
        let j = serde_json::to_string(&b).unwrap();
        assert_eq!(j, r#"{"kind":"box","size":[1.0,1.0,1.0]}"#);
    }
}
