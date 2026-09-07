//! Naming a mesh boundary face after the Solid face it lies on (C §2.4), shared by every
//! mesher that meshes a whole `Solid`.
//!
//! The lattice mesher and the tet mesher both end with a set of boundary faces and no names
//! for them, and both answer the same question the same way: the nearest Solid triangle whose
//! normal agrees with the face's, and its tag. One copy keeps `<body>.<tag>` meaning the same
//! thing whichever mesher built the mesh.

use crate::solid::{point_triangle_distance, Solid};

/// A boundary face inherits a Solid face's tag only if their normals agree within 45°.
pub(crate) const TAG_COS: f64 = std::f64::consts::FRAC_1_SQRT_2;

type Triangle = [[f64; 3]; 3];

/// The Solid's tagged faces, ready to name a mesh boundary face by proximity.
pub(crate) struct Tagger<'a> {
    solid: &'a Solid,
    /// 3D only: per Solid triangle its vertices, unit normal and tag.
    tris: Vec<(Triangle, [f64; 3], &'a str)>,
}

impl<'a> Tagger<'a> {
    pub(crate) fn new(solid: &'a Solid) -> Tagger<'a> {
        let tri = solid.triangles();
        let tris = tri
            .triangles
            .iter()
            .enumerate()
            .map(|(t, v)| {
                let p = [tri.positions[v[0] as usize], tri.positions[v[1] as usize], tri.positions[v[2] as usize]];
                (p, unit_normal(p), tri.tag_of(t))
            })
            .collect();
        Tagger { solid, tris }
    }

    /// The tag of the Solid face nearest `centroid` whose normal is within 45° of `normal`
    /// (3D), or of the nearest outline edge (2D).
    ///
    /// ponytail: a linear scan over the Solid's triangles per boundary face. Index them if a
    /// body ever has enough triangles for this to show up in a profile.
    pub(crate) fn nearest(&self, centroid: [f64; 3], normal: [f64; 3]) -> Option<&'a str> {
        if self.solid.dim() == 2 {
            let p = [centroid[0], centroid[1]];
            return self
                .solid
                .outline()
                .iter()
                .map(|l| {
                    let (edge, d) = l.nearest_edge(p);
                    (d, l.tags[edge].as_str())
                })
                .min_by(|a, b| a.0.total_cmp(&b.0))
                .map(|(_, tag)| tag);
        }
        self.tris
            .iter()
            .filter(|(_, n, _)| dot(*n, normal) >= TAG_COS)
            // Triangle centroids are not a surface-distance proxy: a broad cavity wall
            // can lose to a nearby outer wall even when the mesh face lies on the cavity.
            .map(|(p, _, tag)| (point_triangle_distance(centroid, p), *tag))
            .min_by(|a, b| a.0.total_cmp(&b.0))
            .map(|(_, tag)| tag)
    }
}

pub(crate) fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn distance2(a: [f64; 3], b: [f64; 3]) -> f64 {
    let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    dot(d, d)
}

pub(crate) fn unit_normal(p: Triangle) -> [f64; 3] {
    let u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    let v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    let len = libm::sqrt(dot(n, n)).max(f64::MIN_POSITIVE);
    [n[0] / len, n[1] / len, n[2] / len]
}
