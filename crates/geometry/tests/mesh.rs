//! Mesh type, Abaqus tables and the structured builders. One binary (AGENTS.md coverage rule).

use std::collections::{BTreeMap, BTreeSet};
use std::f64::consts::{FRAC_PI_2, PI};

use femlab_geometry::{
    annulus, elliptic_annulus, perturb_interior, split_to_simplices, ElementBlock, ElementKind, Face, FaceKind, Mesh,
    Structured,
};
use proptest::prelude::*;

const KINDS: [ElementKind; 8] = [
    ElementKind::Hex8,
    ElementKind::Hex20,
    ElementKind::Tet4,
    ElementKind::Tet10,
    ElementKind::Quad4,
    ElementKind::Quad8,
    ElementKind::Tri3,
    ElementKind::Tri6,
];

// ---- independent oracles ---------------------------------------------------------------------

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn mean(ps: &[[f64; 3]]) -> [f64; 3] {
    let mut c = [0.0; 3];
    for p in ps {
        for k in 0..3 {
            c[k] += p[k] / ps.len() as f64;
        }
    }
    c
}
fn det3(m: [[f64; 3]; 3]) -> f64 {
    dot(m[0], cross(m[1], m[2]))
}

/// Reference corners of the Abaqus hex (the first four, at z = -1, are the quad's).
const HEX_REF: [[f64; 3]; 8] = [
    [-1.0, -1.0, -1.0],
    [1.0, -1.0, -1.0],
    [1.0, 1.0, -1.0],
    [-1.0, 1.0, -1.0],
    [-1.0, -1.0, 1.0],
    [1.0, -1.0, 1.0],
    [1.0, 1.0, 1.0],
    [-1.0, 1.0, 1.0],
];

/// One-point Jacobian measure of an element from its corners: exact for affine cells and
/// bilinear quads, second-order for mapped hexes.
fn corner_measure(kind: ElementKind, p: &[[f64; 3]]) -> f64 {
    match kind.n_corners() {
        8 => {
            let mut j = [[0.0; 3]; 3];
            for (c, x) in p.iter().enumerate() {
                for a in 0..3 {
                    for b in 0..3 {
                        j[a][b] += HEX_REF[c][b] / 8.0 * x[a];
                    }
                }
            }
            8.0 * det3(j)
        }
        4 if kind.dim() == 3 => det3([sub(p[1], p[0]), sub(p[2], p[0]), sub(p[3], p[0])]) / 6.0,
        4 => {
            let mut j = [[0.0; 2]; 2];
            for (c, x) in p.iter().enumerate() {
                for a in 0..2 {
                    for b in 0..2 {
                        j[a][b] += HEX_REF[c][b] / 4.0 * x[a];
                    }
                }
            }
            4.0 * (j[0][0] * j[1][1] - j[0][1] * j[1][0])
        }
        _ => cross(sub(p[1], p[0]), sub(p[2], p[0]))[2] / 2.0,
    }
}

fn corners(m: &Mesh, e: u32) -> Vec<[f64; 3]> {
    m.elem_nodes(e)[..m.kind_of(e).n_corners()].iter().map(|&n| m.node(n)).collect()
}

fn measure(m: &Mesh) -> f64 {
    (0..m.n_elems() as u32).map(|e| corner_measure(m.kind_of(e), &corners(m, e))).sum()
}

fn min_element_measure(m: &Mesh) -> f64 {
    (0..m.n_elems() as u32).map(|e| corner_measure(m.kind_of(e), &corners(m, e))).fold(f64::INFINITY, f64::min)
}

fn face_set_nodes(m: &Mesh, name: &str) -> BTreeSet<u32> {
    m.face_sets[name].iter().flat_map(|&f| m.face_nodes(f)).collect()
}

fn nodes_where(m: &Mesh, set: &str, pred: fn([f64; 3]) -> bool) -> bool {
    m.node_sets[set].iter().all(|&n| pred(m.node(n)))
}

fn is_sorted_unique<T: Ord>(v: &[T]) -> bool {
    v.windows(2).all(|w| w[0] < w[1])
}

fn cube(kind: ElementKind, n: [usize; 3]) -> Mesh {
    Structured { kind, n }.box_([1.0, 1.0, 1.0])
}

// ---- element kind tables ---------------------------------------------------------------------

#[test]
fn kind_tables_sizes_orderings_and_serde() {
    let expect = [
        (8, 3, 6, 8, 12, 4),
        (20, 3, 6, 8, 12, 4),
        (4, 3, 4, 4, 6, 3),
        (10, 3, 4, 4, 6, 3),
        (4, 2, 4, 4, 4, 2),
        (8, 2, 4, 4, 4, 2),
        (3, 2, 3, 3, 3, 2),
        (6, 2, 3, 3, 3, 2),
    ];
    for (kind, (n_nodes, dim, n_faces, n_corners, n_edges, face_corners)) in KINDS.iter().zip(expect) {
        assert_eq!(
            (kind.n_nodes(), kind.dim(), kind.n_faces(), kind.n_corners(), kind.edges().len()),
            (n_nodes, dim, n_faces, n_corners, n_edges),
            "{kind:?}"
        );
        let quadratic = n_nodes > n_corners;
        assert_eq!(n_nodes, if quadratic { n_corners + n_edges } else { n_corners });
        let fk = kind.face_kind();
        assert_eq!(fk.n_corners(), face_corners);
        for e in kind.edges() {
            assert!(e[0] != e[1] && (e[1] as usize) < n_corners && (e[0] as usize) < n_corners);
        }
        for f in 0..n_faces {
            let face = kind.face_nodes(f);
            assert_eq!(face.len(), fk.n_nodes(), "{kind:?} face {f}");
            assert_eq!(face.iter().collect::<BTreeSet<_>>().len(), face.len(), "{kind:?} face {f} repeats a node");
            assert!(face.iter().all(|&n| (n as usize) < n_nodes));
            let nc = fk.n_corners();
            assert!(face[..nc].iter().all(|&n| (n as usize) < n_corners));
            for i in 0..face.len() - nc {
                let (a, b) = (face[i], face[(i + 1) % nc]);
                let edge = kind.edges()[face[nc + i] as usize - n_corners];
                assert!(edge == [a, b] || edge == [b, a], "{kind:?} face {f}: mid-node {i} is not on edge ({a}, {b})");
            }
        }
        // Every element edge lies on exactly dim - 1 faces (a 2D edge is a face itself).
        for e in kind.edges() {
            let on = (0..n_faces)
                .filter(|&f| kind.face_nodes(f)[..fk.n_corners()].iter().filter(|n| e.contains(n)).count() == 2)
                .count();
            assert_eq!(on, dim - 1, "{kind:?} edge {e:?}");
        }
        let json = serde_json::to_string(kind).unwrap();
        assert_eq!(serde_json::from_str::<ElementKind>(&json).unwrap(), *kind);
    }
    assert_eq!(serde_json::to_string(&ElementKind::Hex20).unwrap(), "\"hex20\"");
    assert_eq!(serde_json::to_string(&FaceKind::Line3).unwrap(), "\"line3\"");
    assert_eq!(ElementKind::Hex20.face_nodes(0), &[0, 3, 2, 1, 11, 10, 9, 8]);
    assert_eq!(ElementKind::Tet10.face_nodes(3), &[2, 0, 3, 6, 7, 9]);
    assert!(ElementKind::Hex8 < ElementKind::Tri6);
}

#[test]
fn face_normals_point_outward_for_every_kind() {
    for kind in KINDS {
        let m = Structured { kind, n: [1, 1, 1] }.box_([1.0, 2.0, 3.0]);
        m.validate().unwrap();
        assert!(min_element_measure(&m) > 0.0, "{kind:?} has a negatively oriented element");
        let nc = kind.face_kind().n_corners();
        for e in 0..m.n_elems() as u32 {
            let ec = mean(&corners(&m, e));
            for local in 0..kind.n_faces() as u8 {
                let p: Vec<[f64; 3]> = m.face_nodes(Face { elem: e, local }).map(|n| m.node(n)).collect();
                let normal = if kind.dim() == 3 {
                    cross(sub(p[1], p[0]), sub(p[2], p[0]))
                } else {
                    let t = sub(p[1], p[0]);
                    [t[1], -t[0], 0.0]
                };
                assert!(
                    dot(normal, sub(mean(&p[..nc]), ec)) > 0.0,
                    "{kind:?} face {local} of element {e} points inward"
                );
                for (i, mid) in p[nc..].iter().enumerate() {
                    let chord = mean(&[p[i], p[(i + 1) % nc]]);
                    assert!(
                        dot(sub(*mid, chord), sub(*mid, chord)) < 1e-24,
                        "{kind:?} face {local} mid-node {i} off its edge"
                    );
                }
            }
        }
    }
}

// ---- box counts, sets, adjacency, surface ----------------------------------------------------

#[test]
fn box_has_exact_counts_volume_and_sets() {
    let size = [1.0, 2.0, 3.0];
    let s = |kind| Structured { kind, n: [2, 3, 4] }.box_(size);
    let hex8 = s(ElementKind::Hex8);
    assert_eq!((hex8.n_nodes(), hex8.n_elems()), (60, 24));
    assert!((measure(&hex8) - 6.0).abs() < 1e-12);
    assert_eq!(hex8.boundary_faces().len(), 2 * (2 * 3 + 3 * 4 + 4 * 2));
    let sizes: Vec<(&str, usize)> = hex8.face_sets.iter().map(|(k, v)| (k.as_str(), v.len())).collect();
    assert_eq!(sizes, [("xmax", 12), ("xmin", 12), ("ymax", 8), ("ymin", 8), ("zmax", 6), ("zmin", 6)]);
    assert_eq!(hex8.node_sets["xmin"].len(), 20);
    assert!(nodes_where(&hex8, "xmin", |p| p[0] == 0.0));
    assert!(nodes_where(&hex8, "xmax", |p| p[0] == 1.0));
    assert!(nodes_where(&hex8, "ymin", |p| p[1] == 0.0));
    assert!(nodes_where(&hex8, "ymax", |p| p[1] == 2.0));
    assert!(nodes_where(&hex8, "zmin", |p| p[2] == 0.0));
    assert!(nodes_where(&hex8, "zmax", |p| p[2] == 3.0));
    for name in ["xmin", "xmax", "ymin", "ymax", "zmin", "zmax"] {
        let from_faces = face_set_nodes(&hex8, name);
        assert_eq!(from_faces, hex8.node_sets[name].iter().copied().collect(), "{name}");
    }
    assert_eq!(hex8.elem_sets["all"], (0..24).collect::<Vec<u32>>());
    assert_eq!(hex8.bbox(), ([0.0; 3], size));
    assert_eq!(hex8.block_of(23), (0, 23));
    let mut out = [0.0; 24];
    hex8.elem_coords(5, &mut out);
    assert_eq!(&out[21..24], &hex8.node(hex8.elem_nodes(5)[7]));

    assert_eq!(s(ElementKind::Hex20).n_nodes(), 60 + 2 * 4 * 5 + 3 * 3 * 5 + 4 * 3 * 4);
    let tet4 = s(ElementKind::Tet4);
    assert_eq!((tet4.n_nodes(), tet4.n_elems()), (60, 144));
    assert!((measure(&tet4) - 6.0).abs() < 1e-12);
    assert_eq!(s(ElementKind::Tet10).n_nodes(), 193 + (3 * 3 * 4 + 2 * 4 * 4 + 2 * 3 * 5) + 24);

    let quad4 = s(ElementKind::Quad4);
    assert_eq!((quad4.n_nodes(), quad4.n_elems(), quad4.dim), (12, 6, 2));
    assert!((measure(&quad4) - 2.0).abs() < 1e-12);
    assert_eq!(quad4.boundary_faces().len(), 10);
    assert_eq!(quad4.face_sets.keys().collect::<Vec<_>>(), ["xmax", "xmin", "ymax", "ymin"]);
    assert_eq!(quad4.bbox(), ([0.0; 3], [1.0, 2.0, 0.0]));
    assert_eq!(s(ElementKind::Quad8).n_nodes(), 12 + 2 * 4 + 3 * 3);
    let tri3 = s(ElementKind::Tri3);
    assert_eq!((tri3.n_nodes(), tri3.n_elems()), (12, 12));
    assert!((measure(&tri3) - 2.0).abs() < 1e-12);
    assert_eq!(s(ElementKind::Tri6).n_nodes(), 29 + 6);
}

#[test]
fn boundary_faces_and_node_adjacency() {
    let m = cube(ElementKind::Hex8, [2, 2, 2]);
    let boundary = m.boundary_faces();
    assert_eq!(boundary.len(), 24);
    assert!(is_sorted_unique(&boundary));
    let tagged: BTreeSet<Face> = m.face_sets.values().flatten().copied().collect();
    assert_eq!(tagged, boundary.iter().copied().collect());
    let adj = m.node_to_elems();
    assert_eq!(adj.items.len(), 64);
    let centre = (0..27).find(|&n| m.node(n) == [0.5; 3]).unwrap();
    assert_eq!(adj.of(centre as usize), &[0, 1, 2, 3, 4, 5, 6, 7]);
    assert_eq!(adj.of(0), &[0]);
    for n in 0..27 {
        assert!(is_sorted_unique(adj.of(n)));
    }
    let tets = cube(ElementKind::Tet4, [1, 1, 1]);
    let adj = tets.node_to_elems();
    assert_eq!(adj.of(0), &[0, 1, 2, 3, 4, 5], "the Kuhn diagonal touches every tet");
    assert_eq!(adj.of(7), &[0, 1, 2, 3, 4, 5], "node 7 is the (1,1,1) corner in k-j-i numbering");
    assert_eq!(adj.of(1).len(), 2);
}

#[test]
fn surface_of_unit_box_has_twelve_named_outward_triangles() {
    let m = cube(ElementKind::Hex8, [1, 1, 1]);
    let s = m.surface();
    assert_eq!(s.positions.len(), 8);
    assert_eq!(s.triangles.len(), 12);
    assert_eq!(s.faces.len(), 6);
    assert!(s.edges.is_empty());
    assert_eq!(s.set_names, ["xmax", "xmin", "ymax", "ymin", "zmax", "zmin"]);
    assert!(s.tri_elem.iter().all(|&e| e == 0));
    let mut per_set = BTreeMap::new();
    for (t, tri) in s.triangles.iter().enumerate() {
        let p = [s.positions[tri[0] as usize], s.positions[tri[1] as usize], s.positions[tri[2] as usize]];
        let c = mean(&p);
        assert!(dot(cross(sub(p[1], p[0]), sub(p[2], p[0])), sub(c, [0.5; 3])) > 0.0, "triangle {t} faces inward");
        let expect = (0..3)
            .flat_map(|k| [(k, 0.0, "min"), (k, 1.0, "max")])
            .find(|&(k, v, _)| p.iter().all(|q| q[k] == v))
            .map(|(k, _, side)| format!("{}{side}", ["x", "y", "z"][k]))
            .unwrap();
        let fi = s.tri_face[t].unwrap() as usize;
        assert_eq!(s.set_names[s.set_of_face[fi].unwrap() as usize], expect);
        *per_set.entry(expect).or_insert(0) += 1;
    }
    assert!(per_set.values().all(|&n| n == 2));

    let mut m = cube(ElementKind::Hex8, [1, 1, 1]);
    m.face_sets.remove("zmax");
    assert_eq!(m.surface().set_of_face.iter().filter(|s| s.is_none()).count(), 1);

    let m = cube(ElementKind::Quad4, [1, 1, 1]);
    let s = m.surface();
    assert_eq!((s.triangles.len(), s.faces.len(), s.edges.len()), (2, 4, 4));
    assert!(s.tri_face.iter().all(Option::is_none));
    for tri in &s.triangles {
        let p = [s.positions[tri[0] as usize], s.positions[tri[1] as usize], s.positions[tri[2] as usize]];
        assert!(cross(sub(p[1], p[0]), sub(p[2], p[0]))[2] > 0.0);
    }
    for (i, e) in s.edges.iter().enumerate() {
        let (a, b) = (s.positions[e[0] as usize], s.positions[e[1] as usize]);
        let name = &s.set_names[s.set_of_face[i].unwrap() as usize];
        let on = |k: usize, v: f64| a[k] == v && b[k] == v;
        assert!(match name.as_str() {
            "xmin" => on(0, 0.0),
            "xmax" => on(0, 1.0),
            "ymin" => on(1, 0.0),
            _ => name == "ymax" && on(1, 1.0),
        });
    }
}

// ---- validate --------------------------------------------------------------------------------

type Defect = (fn(&mut Mesh), &'static str);

fn broken(f: fn(&mut Mesh)) -> String {
    let mut m = cube(ElementKind::Hex8, [2, 1, 1]);
    f(&mut m);
    m.validate().unwrap_err().0
}

#[test]
fn validate_catches_every_defect() {
    cube(ElementKind::Hex8, [2, 1, 1]).validate().unwrap();
    let cases: [Defect; 14] = [
        (|m| m.coords.push(0.0), "not a multiple of 3"),
        (|m| m.dim = 4, "dim must be 2 or 3"),
        (|m| m.blocks[0].kind = ElementKind::Quad4, "block 0 is Quad4 in a 3D mesh"),
        (|m| m.blocks[0].conn.push(0), "conn length 17 is not a multiple of 8"),
        (|m| m.blocks[0].first_elem = 1, "first_elem 1 but the previous block ends at 0"),
        (|m| m.blocks[0].conn[3] = 99, "references node 99 but the mesh has 12"),
        (
            |m| {
                m.node_sets.insert("s".into(), vec![1, 0]);
            },
            "node set 's' is not sorted",
        ),
        (
            |m| {
                m.node_sets.insert("s".into(), vec![0, 0]);
            },
            "node set 's' is not sorted",
        ),
        (
            |m| {
                m.node_sets.insert("s".into(), vec![0, 12]);
            },
            "node set 's' references node 12",
        ),
        (
            |m| {
                m.elem_sets.insert("s".into(), vec![1, 1]);
            },
            "element set 's' is not sorted",
        ),
        (
            |m| {
                m.elem_sets.insert("s".into(), vec![0, 2]);
            },
            "element set 's' references element 2",
        ),
        (
            |m| {
                m.face_sets.insert("s".into(), vec![Face { elem: 1, local: 0 }, Face { elem: 0, local: 0 }]);
            },
            "face set 's' is not sorted",
        ),
        (
            |m| {
                m.face_sets.insert("s".into(), vec![Face { elem: 2, local: 0 }]);
            },
            "face set 's' references element 2",
        ),
        (
            |m| {
                m.face_sets.insert("s".into(), vec![Face { elem: 1, local: 6 }]);
            },
            "element 1 has no face 6",
        ),
    ];
    for (f, expect) in cases {
        let msg = broken(f);
        assert!(msg.contains(expect), "expected '{expect}' in '{msg}'");
        assert_eq!(femlab_geometry::GeomError(msg.clone()).to_string(), msg);
    }
    // Two contiguous blocks are fine, and block_of / kind_of address the second one.
    let mut m = cube(ElementKind::Hex8, [2, 1, 1]);
    let second = m.blocks[0].conn.split_off(8);
    m.blocks.push(ElementBlock { kind: ElementKind::Hex8, conn: second, first_elem: 1 });
    m.validate().unwrap();
    assert_eq!(m.block_of(1), (1, 0));
    assert_eq!(m.n_elems(), 2);
    assert_eq!(m.kind_of(1), ElementKind::Hex8);
    m.blocks[1].first_elem = 2;
    assert!(m.validate().unwrap_err().0.contains("block 1: first_elem 2"));
}

// ---- mapped meshes: annulus and elliptic annulus ---------------------------------------------

fn radius(p: [f64; 3]) -> f64 {
    libm::sqrt(p[0] * p[0] + p[1] * p[1])
}

#[test]
fn annulus_area_converges_and_curved_nodes_sit_on_the_circle() {
    let exact = PI / 4.0 * (4.0 - 1.0);
    for kind in [ElementKind::Quad4, ElementKind::Quad8, ElementKind::Tri3, ElementKind::Tri6] {
        let err = |n: usize| (measure(&annulus(kind, n, 2 * n, 1.0, 2.0, [0.0, FRAC_PI_2])) - exact).abs();
        let (e4, e8) = (err(4), err(8));
        assert!(e8 < 1e-2 * exact && e4 / e8 > 3.5, "{kind:?}: errors {e4} {e8}");
        let m = annulus(kind, 3, 5, 1.0, 2.0, [0.0, FRAC_PI_2]);
        m.validate().unwrap();
        assert!(min_element_measure(&m) > 0.0);
        assert_eq!(m.face_sets.keys().collect::<Vec<_>>(), ["inner", "outer", "theta0", "theta1"]);
        assert_eq!(m.node_sets.keys().collect::<Vec<_>>(), ["inner", "outer", "theta0", "theta1"]);
        assert!(nodes_where(&m, "inner", |p| (radius(p) - 1.0).abs() < 1e-12));
        assert!(nodes_where(&m, "outer", |p| (radius(p) - 2.0).abs() < 1e-12));
        assert!(nodes_where(&m, "theta0", |p| p[1].abs() < 1e-12));
        assert!(nodes_where(&m, "theta1", |p| p[0].abs() < 1e-12));
        assert!(m.node_sets["inner"].len() >= 6, "corner and (for quadratic kinds) mid-edge nodes");
        assert_eq!(m.face_sets["inner"].len(), 5);
        for name in ["inner", "outer", "theta0", "theta1"] {
            assert_eq!(face_set_nodes(&m, name), m.node_sets[name].iter().copied().collect(), "{kind:?} {name}");
        }
    }
}

fn on_ellipse(p: [f64; 3], ab: [f64; 2]) -> f64 {
    (p[0] / ab[0]).powi(2) + (p[1] / ab[1]).powi(2) - 1.0
}

#[test]
fn elliptic_annulus_converges_in_2d_and_extrudes_in_3d() {
    let (inner, outer) = ([2.0, 1.0], [3.25, 2.75]);
    let exact = PI / 4.0 * (outer[0] * outer[1] - inner[0] * inner[1]);
    let err2 =
        |n: usize| (measure(&elliptic_annulus(ElementKind::Quad8, [n, 2 * n], inner, outer, None)) - exact).abs();
    assert!(err2(4) / err2(8) > 3.5);
    let m = elliptic_annulus(ElementKind::Quad8, [2, 3], inner, outer, None);
    m.validate().unwrap();
    assert_eq!(m.face_sets.keys().collect::<Vec<_>>(), ["inner", "outer", "x0", "y0"]);
    assert!(nodes_where(&m, "inner", |p| on_ellipse(p, [2.0, 1.0]).abs() < 1e-12));
    assert!(nodes_where(&m, "outer", |p| on_ellipse(p, [3.25, 2.75]).abs() < 1e-12));
    assert!(nodes_where(&m, "x0", |p| p[0].abs() < 1e-12));
    assert!(nodes_where(&m, "y0", |p| p[1].abs() < 1e-12));

    let err3 = |n: usize| {
        (measure(&elliptic_annulus(ElementKind::Hex8, [n, 2 * n], inner, outer, Some((0.6, 2)))) - 0.6 * exact).abs()
    };
    assert!(err3(4) / err3(8) > 3.5);
    for kind in [ElementKind::Hex20, ElementKind::Tet4] {
        let m = elliptic_annulus(kind, [2, 3], inner, outer, Some((0.6, 2)));
        m.validate().unwrap();
        assert!(min_element_measure(&m) > 0.0);
        assert_eq!(m.face_sets.keys().collect::<Vec<_>>(), ["bottom", "inner", "outer", "top", "x0", "y0"]);
        assert!(nodes_where(&m, "bottom", |p| p[2] == 0.0));
        assert!(nodes_where(&m, "top", |p| (p[2] - 0.6).abs() < 1e-12));
        assert!(nodes_where(&m, "inner", |p| on_ellipse(p, [2.0, 1.0]).abs() < 1e-12));
        assert_eq!(m.bbox().1[2], 0.6);
    }
    let m = elliptic_annulus(ElementKind::Tet10, [2, 3], inner, outer, None);
    assert_eq!((m.bbox().1[2], m.n_elems()), (1.0, 6 * 2 * 3));
    // The new face-diagonal nodes come from the quad8 face interpolant, which on an extruded
    // curve reproduces the mid-edge node exactly; a chord midpoint would be ~1.9e-2 off.
    let inner_nodes = face_set_nodes(&m, "inner");
    assert!(
        inner_nodes.len()
            > face_set_nodes(&elliptic_annulus(ElementKind::Hex20, [2, 3], inner, outer, None), "inner").len()
    );
    assert!(inner_nodes.iter().all(|&n| on_ellipse(m.node(n), [2.0, 1.0]).abs() < 1e-12));
    assert_eq!(inner_nodes, m.node_sets["inner"].iter().copied().collect(), "new face nodes joined the node set");
}

// ---- split, perturb --------------------------------------------------------------------------

#[test]
fn split_to_simplices_preserves_volume_boundary_and_sets() {
    let hex = Structured { kind: ElementKind::Hex8, n: [2, 2, 2] }.box_([1.0, 2.0, 3.0]);
    let tet = split_to_simplices(&hex);
    tet.validate().unwrap();
    assert_eq!((tet.n_nodes(), tet.n_elems(), tet.blocks[0].kind), (27, 48, ElementKind::Tet4));
    assert!((measure(&tet) - measure(&hex)).abs() < 1e-12);
    assert!(min_element_measure(&tet) > 0.0);
    assert_eq!(tet.boundary_faces().len(), 2 * hex.boundary_faces().len());
    for name in hex.face_sets.keys() {
        assert_eq!(face_set_nodes(&hex, name), face_set_nodes(&tet, name), "{name}");
        assert_eq!(tet.face_sets[name].len(), 2 * hex.face_sets[name].len());
        assert!(is_sorted_unique(&tet.face_sets[name]));
    }
    assert_eq!(tet.elem_sets["all"], (0..48).collect::<Vec<u32>>());
    assert_eq!(tet.node_sets, hex.node_sets);

    let hex20 = Structured { kind: ElementKind::Hex20, n: [2, 1, 1] }.box_([2.0, 1.0, 1.0]);
    let tet10 = split_to_simplices(&hex20);
    tet10.validate().unwrap();
    assert_eq!((hex20.n_nodes(), tet10.n_nodes()), (32, 32 + 11 + 2));
    for e in 0..tet10.n_elems() as u32 {
        let nodes = tet10.elem_nodes(e);
        for (i, edge) in ElementKind::Tet10.edges().iter().enumerate() {
            let mid = tet10.node(nodes[4 + i]);
            let chord = mean(&[tet10.node(nodes[edge[0] as usize]), tet10.node(nodes[edge[1] as usize])]);
            assert_eq!(mid, chord, "element {e} mid-node {i}");
        }
    }
    let centre_nodes: Vec<[f64; 3]> = (32..45).map(|n| tet10.node(n)).collect();
    for c in [[0.5, 0.5, 0.5], [1.5, 0.5, 0.5], [1.0, 0.5, 0.5]] {
        assert_eq!(centre_nodes.iter().filter(|&&p| p == c).count(), 1, "centre node {c:?} exists exactly once");
    }
    assert_eq!(tet10.node_sets["xmin"].len(), 9, "8 quad8 nodes plus the face-centre node");
    assert!(nodes_where(&tet10, "xmin", |p| p[0] == 0.0));

    let quad8 = Structured { kind: ElementKind::Quad8, n: [2, 1, 1] }.box_([2.0, 1.0, 0.0]);
    let tri6 = split_to_simplices(&quad8);
    tri6.validate().unwrap();
    assert_eq!((tri6.n_nodes(), tri6.n_elems()), (13 + 2, 4));
    assert!((measure(&tri6) - 2.0).abs() < 1e-12);
    for name in quad8.face_sets.keys() {
        assert_eq!(face_set_nodes(&quad8, name), face_set_nodes(&tri6, name), "{name}");
    }

    // Simplex blocks pass through unchanged.
    let again = split_to_simplices(&tet);
    assert_eq!(again, tet);
}

#[test]
fn perturb_interior_moves_only_interior_nodes_deterministically() {
    let base = cube(ElementKind::Hex8, [3, 3, 3]);
    let boundary: BTreeSet<u32> = base.boundary_faces().iter().flat_map(|&f| base.face_nodes(f)).collect();
    assert_eq!(boundary.len(), 64 - 8);
    let mut a = base.clone();
    perturb_interior(&mut a, 0.05, 7);
    a.validate().unwrap();
    for n in 0..64u32 {
        let d = sub(a.node(n), base.node(n));
        if boundary.contains(&n) {
            assert_eq!(d, [0.0; 3]);
        } else {
            assert!(d.iter().all(|x| x.abs() <= 0.05 && *x != 0.0), "interior node {n} moved by {d:?}");
        }
    }
    let mut b = base.clone();
    perturb_interior(&mut b, 0.05, 7);
    assert_eq!(a, b);
    perturb_interior(&mut b, 0.05, 8);
    assert_ne!(a, b);
    assert!(min_element_measure(&a) > 0.0);

    let mut sheet = cube(ElementKind::Quad4, [3, 3, 1]);
    perturb_interior(&mut sheet, 0.1, 1);
    assert!(sheet.coords.chunks_exact(3).all(|p| p[2] == 0.0), "2D perturbation stays in the plane");
    assert_ne!(sheet, cube(ElementKind::Quad4, [3, 3, 1]));
}

#[test]
fn mesh_round_trips_through_serde_and_has_a_schema() {
    let m = cube(ElementKind::Tri6, [1, 1, 1]);
    let json = serde_json::to_string(&m).unwrap();
    assert_eq!(serde_json::from_str::<Mesh>(&json).unwrap(), m);
    let s = Structured { kind: ElementKind::Hex20, n: [1, 2, 3] };
    assert_eq!(serde_json::to_string(&s).unwrap(), r#"{"kind":"hex20","n":[1,2,3]}"#);
    let schema = serde_json::to_value(schemars::schema_for!(Mesh)).unwrap();
    assert!(schema["properties"]["face_sets"].is_object());
    assert!(serde_json::to_value(schemars::schema_for!(femlab_geometry::Surface)).unwrap()["properties"]["triangles"]
        .is_object());
}

// ---- property tests --------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn sets_are_sorted_unique_and_sized_for_any_grid(k in 0usize..8, nx in 1usize..4, ny in 1usize..4, nz in 1usize..4) {
        let kind = KINDS[k];
        let m = Structured { kind, n: [nx, ny, nz] }.box_([1.0, 1.0, 1.0]);
        prop_assert!(m.validate().is_ok());
        for set in m.node_sets.values() {
            prop_assert!(is_sorted_unique(set));
        }
        for set in m.face_sets.values() {
            prop_assert!(is_sorted_unique(set));
        }
        prop_assert!(is_sorted_unique(&m.elem_sets["all"]));
        let (nz, faces_per) = if kind.dim() == 3 { (nz, if kind.n_corners() == 4 { 2 } else { 1 }) } else { (1, 1) };
        let children = match kind { ElementKind::Tet4 | ElementKind::Tet10 => 6, ElementKind::Tri3 | ElementKind::Tri6 => 2, _ => 1 };
        prop_assert_eq!(m.n_elems(), nx * ny * nz * children);
        prop_assert_eq!(m.face_sets["xmin"].len(), ny * nz * faces_per);
        prop_assert_eq!(m.face_sets["ymax"].len(), nx * nz * faces_per);
        prop_assert!(m.node_sets["xmin"].iter().all(|&n| m.node(n)[0] == 0.0));
        prop_assert!(m.node_sets["ymax"].iter().all(|&n| m.node(n)[1] == 1.0));
        prop_assert!((measure(&m) - 1.0).abs() < 1e-12);
        let expect_boundary = if kind.dim() == 3 { faces_per * 2 * (nx * ny + ny * nz + nz * nx) } else { 2 * (nx + ny) };
        prop_assert_eq!(m.boundary_faces().len(), expect_boundary);
    }
}
