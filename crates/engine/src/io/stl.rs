//! ASCII STL writer (plan C §3): per-facet normals from the triangle winding, for either a
//! `Solid`'s tagged boundary triangles or a `Mesh`'s boundary skin ([`Mesh::surface`]).
//!
//! And an STL reader for `geometry.import` (#350), ASCII and binary. Facet normals are read
//! past and ignored: the winding is the authority, as it is for everything else here.

use std::collections::BTreeMap;

use femlab_geometry::{Mesh, TriMesh};

use crate::error::{Error, ErrorCode};

fn facet_normal(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> [f64; 3] {
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    let len = libm::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
    if len == 0.0 {
        return [0.0, 0.0, 0.0];
    }
    [n[0] / len, n[1] / len, n[2] / len]
}

fn write_facets(s: &mut String, name: &str, positions: &[[f64; 3]], triangles: &[[u32; 3]]) {
    s.push_str(&format!("solid {name}\n"));
    for t in triangles {
        let (a, b, c) = (positions[t[0] as usize], positions[t[1] as usize], positions[t[2] as usize]);
        let n = facet_normal(a, b, c);
        s.push_str(&format!("facet normal {} {} {}\n", n[0], n[1], n[2]));
        s.push_str(" outer loop\n");
        for p in [a, b, c] {
            s.push_str(&format!("  vertex {} {} {}\n", p[0], p[1], p[2]));
        }
        s.push_str(" endloop\nendfacet\n");
    }
    s.push_str(&format!("endsolid {name}\n"));
}

/// ASCII STL of a `Solid`'s triangulated boundary (`Solid::triangles()`), named `name`.
pub fn write_stl(solid_triangles: &TriMesh, name: &str) -> String {
    let mut s = String::new();
    write_facets(&mut s, name, &solid_triangles.positions, &solid_triangles.triangles);
    s
}

/// ASCII STL of a `Mesh`'s boundary skin (`Mesh::surface()`).
pub fn write_stl_mesh(mesh: &Mesh) -> String {
    let surface = mesh.surface();
    let mut s = String::new();
    write_facets(&mut s, "mesh", &surface.positions, &surface.triangles);
    s
}

// ----------------------------------------------------------------------------- reading

/// Welded vertex positions and the triangles that index them: what an imported file becomes.
pub type Soup = (Vec<[f64; 3]>, Vec<[u32; 3]>);

fn bad(cause: impl Into<String>) -> Error {
    Error::new(ErrorCode::Schema, cause).at("data").suggest("export the part again as an STL, or pass the right format")
}

/// Vertices welded on their exact bits, so a watertight STL comes back watertight and two
/// runs of the same file give the same indices. `-0.0` and `0.0` are one vertex.
struct Welder {
    index: BTreeMap<[u64; 3], u32>,
    positions: Vec<[f64; 3]>,
    triangles: Vec<[u32; 3]>,
    corner: Vec<u32>,
}

impl Welder {
    fn new() -> Welder {
        Welder { index: BTreeMap::new(), positions: Vec::new(), triangles: Vec::new(), corner: Vec::new() }
    }

    fn vertex(&mut self, p: [f64; 3]) {
        let key = [p[0], p[1], p[2]].map(|x| (if x == 0.0 { 0.0 } else { x }).to_bits());
        let next = self.positions.len() as u32;
        let v = *self.index.entry(key).or_insert_with(|| {
            self.positions.push(p);
            next
        });
        self.corner.push(v);
        if self.corner.len() == 3 {
            self.triangles.push([self.corner[0], self.corner[1], self.corner[2]]);
            self.corner.clear();
        }
    }

    fn finish(self) -> Result<Soup, Error> {
        if !self.corner.is_empty() {
            return Err(bad("the STL ends in the middle of a facet"));
        }
        if self.triangles.is_empty() {
            return Err(bad("the STL holds no triangles"));
        }
        Ok((self.positions, self.triangles))
    }
}

/// The 50-byte record of a binary STL: a facet normal, three vertices, an attribute count.
const BINARY_FACET: usize = 50;
/// 80 bytes of header plus the u32 facet count.
const BINARY_HEADER: usize = 84;

/// Read an STL, ASCII or binary, into welded positions and triangles. The format is decided
/// by the file's own length: a binary STL is exactly `84 + 50 n` bytes for its declared `n`.
pub fn read_stl(bytes: &[u8]) -> Result<Soup, Error> {
    if bytes.len() >= BINARY_HEADER {
        let count = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
        if bytes.len() == BINARY_HEADER + BINARY_FACET * count {
            return read_binary(bytes, count);
        }
    }
    read_ascii(bytes)
}

fn read_binary(bytes: &[u8], count: usize) -> Result<Soup, Error> {
    let mut w = Welder::new();
    for f in 0..count {
        // skip the 12 bytes of facet normal; the winding is what orients a triangle
        let base = BINARY_HEADER + BINARY_FACET * f + 12;
        for v in 0..3 {
            let mut p = [0.0f64; 3];
            for (k, slot) in p.iter_mut().enumerate() {
                let at = base + 12 * v + 4 * k;
                *slot = f64::from(f32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]));
            }
            w.vertex(p);
        }
    }
    w.finish()
}

fn read_ascii(bytes: &[u8]) -> Result<Soup, Error> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| bad("the file is neither a binary STL of its declared facet count nor UTF-8 text"))?;
    let mut w = Welder::new();
    let mut words = text.split_ascii_whitespace();
    while let Some(word) = words.next() {
        if !word.eq_ignore_ascii_case("vertex") {
            continue;
        }
        let mut p = [0.0f64; 3];
        for (k, slot) in p.iter_mut().enumerate() {
            let raw = words.next().ok_or_else(|| bad("a vertex line ends before its three coordinates"))?;
            *slot = raw.parse().map_err(|_| bad(format!("'{raw}' is not a number (vertex coordinate {k})")))?;
        }
        w.vertex(p);
    }
    w.finish()
}
