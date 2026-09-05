//! ASCII STL writer (plan C §3): per-facet normals from the triangle winding, for either a
//! `Solid`'s tagged boundary triangles or a `Mesh`'s boundary skin ([`Mesh::surface`]).

use femlab_geometry::{Mesh, TriMesh};

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
