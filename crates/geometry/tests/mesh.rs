//! Mesh type, Abaqus tables and the structured builders. One binary (AGENTS.md coverage rule).

use std::collections::{BTreeMap, BTreeSet};
use std::f64::consts::{FRAC_PI_2, PI};

use femlab_geometry::{
    annulus, elliptic_annulus, extrude, free, line as line_mesher, mapped, merge_coincident, perturb_interior, revolve,
    split_to_simplices, Curve, ElementBlock, ElementKind, Face, FaceKind, Mesh, QuadBlock, RefineBox, Segment,
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

// ---- lattice mesher, predicate resolution and quality -----------------------------------------

use femlab_geometry::{
    lattice, nearest_boundary_face, quality, resolve_face_set, resolve_region, FacePredicate, RegionPredicate, Shape,
    Sketch, Solid,
};

fn solid(shape: Shape) -> Solid {
    Solid::evaluate(&shape).unwrap()
}

fn beam() -> Solid {
    solid(Shape::Box { size: [1.0, 0.1, 0.1] })
}

/// A 4 × 4 × 1 box with a 2 × 2 hole through it, the hole named so its walls carry the name.
fn holed() -> Solid {
    solid(Shape::Subtract {
        from: Box::new(Shape::Box { size: [4.0, 4.0, 1.0] }),
        cut: vec![Shape::Named {
            name: "hole".into(),
            shape: Box::new(Shape::Transform {
                shape: Box::new(Shape::Box { size: [2.0, 2.0, 3.0] }),
                at: femlab_geometry::Affine3 { translate: [1.0, 1.0, -1.0], ..Default::default() },
            }),
        }],
    })
}

fn annulus_sheet() -> Solid {
    solid(Shape::Sheet {
        sketch: Sketch {
            outer: Sketch::circle([0.0, 0.0], 1.0, "outer"),
            holes: vec![Sketch::circle([0.0, 0.0], 0.4, "bore")],
        },
    })
}

fn set_len(m: &Mesh, name: &str) -> usize {
    m.face_sets.get(name).map_or(0, Vec::len)
}

#[test]
fn lattice_is_exact_on_an_aligned_box() {
    let m = lattice(&beam(), None, Some([10, 1, 1]), false).unwrap();
    assert!(m.validate().is_ok());
    assert_eq!(m.n_elems(), 10);
    assert_eq!(m.n_nodes(), 44);
    assert_eq!(m.kind_of(0), ElementKind::Hex8);
    assert_eq!(set_len(&m, "xmin"), 1);
    assert_eq!(set_len(&m, "xmax"), 1);
    assert_eq!(set_len(&m, "ymin"), 10);
    assert_eq!(set_len(&m, "ymax"), 10);
    assert_eq!(set_len(&m, "zmin"), 10);
    assert_eq!(set_len(&m, "zmax"), 10);
    assert_eq!(m.face_sets.keys().cloned().collect::<Vec<_>>(), ["xmax", "xmin", "ymax", "ymin", "zmax", "zmin"]);
    assert_eq!(m.elem_sets["all"].len(), 10);
    assert_eq!(m.boundary_faces().len(), 42);
    assert!((measure(&m) - 0.01).abs() < 1e-15, "{}", measure(&m));
    // the size rule is ceil(extent / size) per axis, at least one cell
    let by_size = lattice(&beam(), Some(0.025), None, false).unwrap();
    assert_eq!(by_size.n_elems(), 40 * 4 * 4);
    assert_eq!(by_size.n_nodes(), 41 * 5 * 5);
    assert_eq!(set_len(&by_size, "xmin"), 16);
    let coarse = lattice(&beam(), Some(10.0), None, false).unwrap();
    assert_eq!(coarse.n_elems(), 1);
    // counts below one are lifted to one
    assert_eq!(lattice(&beam(), None, Some([0, 0, 0]), false).unwrap().n_elems(), 1);
    // neither a size nor counts, and a non-positive size, are errors
    assert!(lattice(&beam(), None, None, false).is_err());
    assert!(lattice(&beam(), Some(0.0), None, false).is_err());
}

#[test]
fn lattice_makes_hex20_quad4_and_quad8() {
    let q = lattice(&beam(), None, Some([2, 1, 1]), true).unwrap();
    assert!(q.validate().is_ok());
    assert_eq!(q.kind_of(0), ElementKind::Hex20);
    assert_eq!(q.n_elems(), 2);
    // two hex20 sharing a face: 20 + 20 nodes less the 8 of the shared face
    assert_eq!(q.n_nodes(), 20 + 20 - 8);
    assert!((measure(&q) - 0.01).abs() < 1e-15);
    let sheet = solid(Shape::Sheet { sketch: Sketch::rect(2.0, 1.0) });
    let s = lattice(&sheet, None, Some([2, 1, 7]), false).unwrap();
    assert!(s.validate().is_ok());
    assert_eq!(s.dim, 2);
    assert_eq!(s.kind_of(0), ElementKind::Quad4);
    assert_eq!(s.n_elems(), 2);
    assert_eq!(s.n_nodes(), 6);
    assert_eq!(set_len(&s, "xmin"), 1);
    assert_eq!(set_len(&s, "ymin"), 2);
    assert!(!s.face_sets.contains_key("zmin"));
    assert!((measure(&s) - 2.0).abs() < 1e-15);
    let s2 = lattice(&sheet, None, Some([2, 1, 1]), true).unwrap();
    assert_eq!(s2.kind_of(0), ElementKind::Quad8);
    assert!((measure(&s2) - 2.0).abs() < 1e-15);
}

#[test]
fn lattice_names_hole_walls_from_the_solid_and_refuses_an_empty_result() {
    let m = lattice(&holed(), None, Some([4, 4, 1]), false).unwrap();
    assert!(m.validate().is_ok());
    assert_eq!(m.n_elems(), 12);
    assert!((measure(&m) - 12.0).abs() < 1e-12);
    assert_eq!(set_len(&m, "hole.xmin"), 2);
    assert_eq!(set_len(&m, "hole.xmax"), 2);
    assert_eq!(set_len(&m, "hole.ymin"), 2);
    assert_eq!(set_len(&m, "hole.ymax"), 2);
    assert_eq!(set_len(&m, "zmin"), 12);
    assert_eq!(set_len(&m, "xmin"), 4);
    // the hole is through, so no cap of it survives
    assert!(!m.face_sets.contains_key("hole.zmin"));
    // a 2D sheet takes its inner tags from the nearest outline edge
    let a = lattice(&annulus_sheet(), None, Some([6, 6, 1]), false).unwrap();
    assert!(a.validate().is_ok());
    assert!(set_len(&a, "bore") > 0, "{:?}", a.face_sets.keys().collect::<Vec<_>>());
    assert!(set_len(&a, "outer") > 0);
    // one cell over the annulus is centred in the bore: nothing is inside, which is an error
    let e = lattice(&annulus_sheet(), None, Some([1, 1, 1]), false).unwrap_err();
    assert!(e.0.contains("no cell whose centre is inside"), "{e}");
}

#[test]
fn predicates_resolve_on_the_mesh_boundary() {
    let m = lattice(&beam(), None, Some([10, 1, 1]), false).unwrap();
    let root = FacePredicate::Plane { normal: [1.0, 0.0, 0.0], offset: 0.0, tol: None };
    assert_eq!(resolve_face_set(&m, &root, None), m.face_sets["xmin"]);
    // restricted to a subset of the boundary, only faces of that subset can match
    let ymin = m.face_sets["ymin"].clone();
    assert!(resolve_face_set(&m, &root, Some(&ymin)).is_empty());
    let up = FacePredicate::Normal { normal: [0.0, 0.0, 1.0], max_angle_deg: None };
    assert_eq!(resolve_face_set(&m, &up, None).len(), 10);
    // the same predicate survives a remesh at three sizes
    for n in [5u32, 10, 20] {
        let r = lattice(&beam(), None, Some([n, 1, 1]), false).unwrap();
        assert_eq!(resolve_face_set(&r, &root, None).len(), 1);
        assert_eq!(resolve_face_set(&r, &up, None).len(), n as usize);
    }
    // 2D: boundary edges with the in-plane outward normal
    let sheet = solid(Shape::Sheet { sketch: Sketch::rect(2.0, 1.0) });
    let s = lattice(&sheet, None, Some([2, 1, 1]), false).unwrap();
    let right = FacePredicate::Normal { normal: [1.0, 0.0, 0.0], max_angle_deg: None };
    assert_eq!(resolve_face_set(&s, &right, None), s.face_sets["xmax"]);
    // regions pick nodes by position and elements by centroid
    let half = RegionPredicate::Bbox { min: [-1.0, -1.0, -1.0], max: [0.5, 1.0, 1.0] };
    let body = |_: u32| "beam";
    let (nodes, elems) = resolve_region(&m, &half, &body);
    assert_eq!(elems.len(), 5);
    assert_eq!(nodes.len(), 6 * 4);
    let (all_nodes, all_elems) = resolve_region(&m, &RegionPredicate::Body { name: "beam".into() }, &body);
    assert_eq!(all_elems.len(), 10);
    assert_eq!(all_nodes.len(), 44);
    let (none_nodes, none_elems) = resolve_region(&m, &RegionPredicate::Body { name: "other".into() }, &body);
    assert!(none_nodes.is_empty() && none_elems.is_empty());
    // the nearest boundary face is what an empty-Set error points at
    let (face, d) = nearest_boundary_face(&m, [-1.0, 0.05, 0.05]).unwrap();
    assert!(m.face_sets["xmin"].contains(&face));
    assert!((d - 1.0).abs() < 1e-12, "{d}");
}

#[test]
fn quality_is_perfect_on_a_lattice_and_zero_on_a_degenerate_element() {
    for m in [
        lattice(&beam(), None, Some([10, 1, 1]), false).unwrap(),
        lattice(&beam(), None, Some([2, 1, 1]), true).unwrap(),
        cube(ElementKind::Tet4, [1, 1, 1]),
        cube(ElementKind::Tri3, [2, 2, 1]),
        cube(ElementKind::Quad4, [2, 2, 1]),
    ] {
        let q = quality(&m, 3);
        assert!((q.min_det_j_ratio - 1.0).abs() < 1e-12, "{q:?}");
        assert!(q.min_angle_deg > 1.0 && q.min_angle_deg <= 90.0 + 1e-9, "{q:?}");
        assert!(q.max_aspect >= 1.0 - 1e-12, "{q:?}");
        assert_eq!(q.worst.len(), m.n_elems().min(3));
    }
    // the beam's cells are 0.1 × 0.1 × 0.1 cubes: aspect 1, corner angles 90°
    let q = quality(&lattice(&beam(), None, Some([10, 1, 1]), false).unwrap(), 2);
    assert!((q.max_aspect - 1.0).abs() < 1e-12, "{q:?}");
    assert!((q.min_angle_deg - 90.0).abs() < 1e-9, "{q:?}");
    assert_eq!(q.worst, [(0, 1.0), (1, 1.0)]);
    // a collapsed hex has no Jacobian and no shortest edge
    let flat = Mesh {
        dim: 3,
        coords: vec![0.0; 24],
        blocks: vec![ElementBlock { kind: ElementKind::Hex8, conn: (0..8).collect(), first_elem: 0 }],
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::new(),
        face_sets: BTreeMap::new(),
    };
    let q = quality(&flat, 5);
    assert_eq!(q.min_det_j_ratio, 0.0);
    assert_eq!(q.max_aspect, f64::MAX);
    assert_eq!(q.min_angle_deg, 90.0);
    assert_eq!(q.worst, [(0, 0.0)]);
    // an empty mesh has nothing to be wrong with
    let empty = Mesh { blocks: vec![], coords: vec![], ..flat };
    assert_eq!(quality(&empty, 5).worst, []);
}

#[test]
fn quality_preserves_orientation_and_scale_in_its_jacobian_ratio() {
    for scale in [0.25, 2.0, 7.0] {
        for kind in KINDS {
            let m = Structured { kind, n: [1, 1, 1] }.box_([scale, scale, scale]);
            assert_eq!(quality(&m, 1).min_det_j_ratio, 1.0, "{kind:?} at scale {scale}");
        }
    }

    // A reflection changes the orientation while preserving the shape, so every corner has the
    // same negative determinant and the independent geometric oracle is exactly -1.
    for kind in KINDS {
        let mut reflected = cube(kind, [1, 1, 1]);
        for p in reflected.coords.chunks_exact_mut(3) {
            p[0] = 2.0 * (1.0 - p[0]);
            p[1] *= 2.0;
            p[2] *= 2.0;
        }
        let q = quality(&reflected, 1);
        assert_eq!(q.min_det_j_ratio, -1.0, "{kind:?}");
        assert_eq!(q.worst[0], (0, -1.0), "{kind:?}");
    }

    // Reversing the corner order is the simplex equivalent of the reflected geometry above.
    for kind in [ElementKind::Tet4, ElementKind::Tet10, ElementKind::Tri3, ElementKind::Tri6] {
        let mut reversed = cube(kind, [1, 1, 1]);
        for conn in reversed.blocks[0].conn.chunks_exact_mut(kind.n_nodes()) {
            conn.swap(0, 1);
        }
        assert_eq!(quality(&reversed, usize::MAX).min_det_j_ratio, -1.0, "{kind:?}");
    }
}

#[test]
fn quality_ranks_mixed_and_inverted_corner_jacobians_as_worst() {
    let mut mixed = cube(ElementKind::Hex8, [1, 1, 1]);
    // Reflect first, then restore one corner across the face. The corner determinants now have
    // both signs; the smallest one must remain negative.
    for p in mixed.coords.chunks_exact_mut(3) {
        p[0] = 1.0 - p[0];
    }
    mixed.coords[3] = 2.0;
    assert_eq!(quality(&mixed, 1).min_det_j_ratio, -1.0);

    // Collapsing the reflected element's first edge creates negative and zero corner
    // determinants. The negative corners must not be hidden by a zero maximum determinant.
    let mut mixed_zero = cube(ElementKind::Hex8, [1, 1, 1]);
    for p in mixed_zero.coords.chunks_exact_mut(3) {
        p[0] = 1.0 - p[0];
    }
    let (first, second) = mixed_zero.coords.split_at_mut(3);
    second[..3].copy_from_slice(first);
    assert_eq!(quality(&mixed_zero, 1).min_det_j_ratio, -1.0);

    // The reflected copy must be selected ahead of the valid element when only one worst
    // element is requested.
    let valid = cube(ElementKind::Hex8, [1, 1, 1]);
    let mut inverted = valid.clone();
    for p in inverted.coords.chunks_exact_mut(3) {
        p[0] = 1.0 - p[0];
    }
    let mut coords = valid.coords.clone();
    coords.extend_from_slice(&inverted.coords);
    let mut conn = valid.blocks[0].conn.clone();
    conn.extend(inverted.blocks[0].conn.iter().map(|&n| n + 8));
    let combined = Mesh {
        dim: 3,
        coords,
        blocks: vec![ElementBlock { kind: ElementKind::Hex8, conn, first_elem: 0 }],
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::new(),
        face_sets: BTreeMap::new(),
    };
    let q = quality(&combined, 1);
    assert_eq!(q.min_det_j_ratio, -1.0);
    assert_eq!(q.worst, [(1, -1.0)]);
}

// ---- mapped quad blocks ----------------------------------------------------------------------

fn block(corners: [[f64; 2]; 4], edges: [Curve; 4], n: [usize; 2], grading: [f64; 2], tags: [&str; 4]) -> QuadBlock {
    QuadBlock { corners, edges, n, grading, tags: tags.map(|t| (!t.is_empty()).then(|| t.to_string())) }
}

const LINES: [Curve; 4] = [Curve::Line, Curve::Line, Curve::Line, Curve::Line];

fn unit_block(n: [usize; 2]) -> QuadBlock {
    block([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]], LINES, n, [1.0, 1.0], ["ymin", "xmax", "ymax", "xmin"])
}

#[test]
fn a_mapped_unit_block_is_the_structured_box() {
    for kind in [ElementKind::Quad4, ElementKind::Quad8, ElementKind::Tri3, ElementKind::Tri6] {
        let m = mapped(&[unit_block([2, 3])], kind).unwrap();
        let s = Structured { kind, n: [2, 3, 1] }.box_([1.0, 1.0, 1.0]);
        m.validate().unwrap();
        assert_eq!((m.n_nodes(), m.n_elems()), (s.n_nodes(), s.n_elems()), "{kind:?}");
        assert_eq!(m.blocks[0].conn, s.blocks[0].conn, "{kind:?}");
        for (a, b) in m.coords.iter().zip(&s.coords) {
            assert!((a - b).abs() < 1e-15, "{kind:?}: {a} vs {b}");
        }
        for name in ["xmin", "xmax", "ymin", "ymax"] {
            assert_eq!(m.face_sets[name], s.face_sets[name], "{kind:?} {name}");
        }
        assert_eq!(m.elem_sets["all"], s.elem_sets["all"]);
        assert!(min_element_measure(&m) > 0.0, "{kind:?}");
    }
    // grading > 1 packs cells toward the u = 0 / v = 0 side, geometrically
    let graded = block([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]], LINES, [4, 1], [2.0, 1.0], ["", "", "", ""]);
    let g = mapped(&[graded], ElementKind::Quad4).unwrap();
    assert!(g.face_sets.is_empty(), "an untagged block names nothing");
    let mut xs: Vec<f64> = g.coords.chunks_exact(3).filter(|p| p[1].abs() < 1e-12).map(|p| p[0]).collect();
    xs.sort_by(f64::total_cmp);
    assert_eq!(xs.len(), 5);
    for i in 0..3 {
        assert!(((xs[i + 2] - xs[i + 1]) / (xs[i + 1] - xs[i]) - 2.0).abs() < 1e-12, "{xs:?}");
    }
    assert!((xs[1] - 1.0 / 15.0).abs() < 1e-15, "u_1 = (1 - r)/(1 - r^n)");
}

/// C §7 C1: the two-block quarter plate with a circular hole of radius `a` in a `w` square.
fn kirsch(a: f64, w: f64, n: usize, grading: f64) -> Vec<QuadBlock> {
    let d = a / 2.0f64.sqrt();
    let arc = Curve::Arc { center: [0.0, 0.0], ccw: false };
    vec![
        block(
            [[a, 0.0], [w, 0.0], [w, w], [d, d]],
            [Curve::Line, Curve::Line, Curve::Line, arc.clone()],
            [n, n],
            [grading, 1.0],
            ["ymin", "xmax", "", "hole"],
        ),
        block(
            [[d, d], [w, w], [0.0, w], [0.0, a]],
            [Curve::Line, Curve::Line, Curve::Line, arc],
            [n, n],
            [grading, 1.0],
            ["", "ymax", "xmin", "hole"],
        ),
    ]
}

#[test]
fn the_kirsch_two_block_plate_merges_its_diagonal_and_names_the_hole() {
    let (a, w, n) = (1.0, 10.0, 4);
    let m = mapped(&kirsch(a, w, n, 1.15), ElementKind::Quad8).unwrap();
    m.validate().unwrap();
    // two quad8 blocks of (2n+1)^2 - n^2 nodes, sharing the 2n+1 nodes of the diagonal
    assert_eq!(m.n_nodes(), 2 * (9 * 9 - n * n) - (2 * n + 1));
    assert_eq!(m.n_elems(), 2 * n * n);
    assert!(min_element_measure(&m) > 0.0);
    assert_eq!(m.face_sets.keys().collect::<Vec<_>>(), ["hole", "xmax", "xmin", "ymax", "ymin"]);
    // the hole is a quarter circle: every node of it, mid-edge nodes included, is at radius a
    assert_eq!(m.face_sets["hole"].len(), 2 * n);
    let hole = face_set_nodes(&m, "hole");
    assert_eq!(hole.len(), 4 * n + 1, "shared node in the middle of the quarter");
    assert!(hole.iter().all(|&i| (radius(m.node(i)) - a).abs() < 1e-12));
    let angles: Vec<f64> = hole.iter().map(|&i| libm::atan2(m.node(i)[1], m.node(i)[0])).collect();
    assert!(angles.iter().copied().fold(f64::INFINITY, f64::min).abs() < 1e-12);
    assert!((angles.iter().copied().fold(0.0, f64::max) - FRAC_PI_2).abs() < 1e-12);
    // every face centroid sits just inside radius a, by the chord error of a 2n-sided quarter
    let chord = a * (1.0 - libm::cos(FRAC_PI_2 / (4.0 * n as f64)));
    for &f in &m.face_sets["hole"] {
        let c = mean(&m.face_nodes(f).take(2).map(|i| m.node(i)).collect::<Vec<_>>());
        assert!(a - radius(c) > 0.0 && a - radius(c) < chord + 1e-12, "{}", radius(c));
    }
    // the radial spacing is graded by 1.15 from the hole outwards along y = 0
    let mut xs: Vec<f64> = m.coords.chunks_exact(3).filter(|p| p[1].abs() < 1e-12).map(|p| p[0]).collect();
    xs.sort_by(f64::total_cmp);
    let corner: Vec<f64> = xs.iter().copied().step_by(2).collect();
    assert_eq!(corner.len(), n + 1);
    for i in 0..n - 1 {
        let r = (corner[i + 2] - corner[i + 1]) / (corner[i + 1] - corner[i]);
        assert!((r - 1.15).abs() < 1e-12, "{corner:?}");
    }
    // a tag on the shared diagonal names nothing: the merge leaves no boundary face there
    let mut tagged = kirsch(a, w, n, 1.0);
    tagged[0].tags[2] = Some("diag".to_string());
    tagged[1].tags[0] = Some("diag".to_string());
    let d = mapped(&tagged, ElementKind::Quad4).unwrap();
    assert!(!d.face_sets.contains_key("diag"), "{:?}", d.face_sets.keys().collect::<Vec<_>>());
    // the same blocks in every 2D kind, each conforming across the shared diagonal
    for kind in [ElementKind::Quad4, ElementKind::Tri3, ElementKind::Tri6] {
        let t = mapped(&kirsch(a, w, n, 1.15), kind).unwrap();
        t.validate().unwrap();
        assert!(min_element_measure(&t) > 0.0, "{kind:?}");
        assert_eq!(t.boundary_faces().len(), t.face_sets.values().map(Vec::len).sum::<usize>(), "{kind:?}");
    }
}

#[test]
fn cooks_membrane_is_one_block_of_the_exact_trapezoid_area() {
    let cook = |n: usize| {
        block(
            [[0.0, 0.0], [48.0, 44.0], [48.0, 60.0], [0.0, 44.0]],
            LINES,
            [n, n],
            [1.0, 1.0],
            ["bottom", "right", "top", "left"],
        )
    };
    // the trapezoid has parallel vertical sides of 44 and 16 a distance 48 apart
    let exact = 0.5 * (44.0 + 16.0) * 48.0;
    for kind in [ElementKind::Quad4, ElementKind::Quad8, ElementKind::Tri3] {
        let m = mapped(&[cook(4)], kind).unwrap();
        m.validate().unwrap();
        assert!((measure(&m) - exact).abs() < 1e-9 * exact, "{kind:?}: {}", measure(&m));
    }
    let m = mapped(&[cook(4)], ElementKind::Quad4).unwrap();
    assert_eq!(m.face_sets["left"].len(), 4);
    assert!(face_set_nodes(&m, "left").iter().all(|&i| m.node(i)[0].abs() < 1e-13));
    assert!(face_set_nodes(&m, "right").iter().all(|&i| (m.node(i)[0] - 48.0).abs() < 1e-13));
}

/// C §7 C5: the NAFEMS LE1 elliptic membrane as one block with two elliptic edges.
fn le1(n: usize) -> Vec<QuadBlock> {
    vec![block(
        [[2.0, 0.0], [3.25, 0.0], [0.0, 2.75], [0.0, 1.0]],
        [
            Curve::Line,
            Curve::Ellipse { center: [0.0, 0.0], semi_axes: [3.25, 2.75] },
            Curve::Line,
            Curve::Ellipse { center: [0.0, 0.0], semi_axes: [2.0, 1.0] },
        ],
        [n, n],
        [1.0, 1.0],
        ["y0", "outer", "x0", "inner"],
    )]
}

#[test]
fn le1_puts_every_node_on_its_two_ellipses_and_converges_in_area() {
    let m = mapped(&le1(3), ElementKind::Quad8).unwrap();
    m.validate().unwrap();
    assert!(min_element_measure(&m) > 0.0);
    assert!(face_set_nodes(&m, "outer").iter().all(|&i| on_ellipse(m.node(i), [3.25, 2.75]).abs() < 1e-12));
    assert!(face_set_nodes(&m, "inner").iter().all(|&i| on_ellipse(m.node(i), [2.0, 1.0]).abs() < 1e-12));
    assert!(face_set_nodes(&m, "y0").iter().all(|&i| m.node(i)[1].abs() < 1e-15));
    assert!(face_set_nodes(&m, "x0").iter().all(|&i| m.node(i)[0].abs() < 1e-15));
    let exact = PI / 4.0 * (3.25 * 2.75 - 2.0 * 1.0);
    let err = |n: usize| (measure(&mapped(&le1(n), ElementKind::Quad8).unwrap()) - exact).abs();
    assert!(err(8) < 1e-2 * exact && err(4) / err(8) > 3.5, "errors {} {}", err(4), err(8));
}

#[test]
fn mapped_refuses_what_it_cannot_mesh() {
    let bad = |b: Vec<QuadBlock>| mapped(&b, ElementKind::Quad4).unwrap_err().0;
    assert!(mapped(&[unit_block([1, 1])], ElementKind::Hex8).unwrap_err().0.contains("2D elements"));
    assert!(mapped(&[], ElementKind::Quad4).unwrap_err().0.contains("at least one block"));
    assert!(bad(vec![unit_block([0, 1])]).contains("both must be at least 1"));
    assert!(bad(vec![unit_block([1, 0])]).contains("both must be at least 1"));
    let mut g = unit_block([1, 1]);
    g.grading = [1.0, 0.0];
    assert!(bad(vec![g.clone()]).contains("grading[1] is 0"));
    g.grading = [f64::NAN, 1.0];
    assert!(bad(vec![g]).contains("grading[0] is NaN"));
    let mut d = unit_block([1, 1]);
    d.corners[1] = [0.0, 0.0];
    assert!(bad(vec![d]).contains("four distinct corners"));
    let mut arc = unit_block([1, 1]);
    arc.edges[1] = Curve::Arc { center: [0.0, 0.0], ccw: true };
    assert!(bad(vec![arc.clone()]).contains("they must be equal"));
    arc.edges[1] = Curve::Arc { center: [1.0, 0.0], ccw: true };
    assert!(bad(vec![arc]).contains("radius 0"));
    let mut el = unit_block([1, 1]);
    el.edges[1] = Curve::Ellipse { center: [0.0, 0.0], semi_axes: [0.0, 1.0] };
    assert!(bad(vec![el.clone()]).contains("both must be positive"));
    el.edges[1] = Curve::Ellipse { center: [0.0, 0.0], semi_axes: [1.0, 1.0] };
    assert!(bad(vec![el]).contains("is not on it"));
    // two blocks sharing an edge they divide, or grade, differently
    let mut k = kirsch(1.0, 10.0, 4, 1.0);
    k[1].n = [8, 4];
    let e = mapped(&k, ElementKind::Quad4).unwrap_err().0;
    assert!(e.contains("block 0 edge 2 and block 1 edge 0") && e.contains("same division count"), "{e}");
    let mut k = kirsch(1.0, 10.0, 4, 1.0);
    k[1].grading = [1.2, 1.0];
    let e = mapped(&k, ElementKind::Quad4).unwrap_err().0;
    assert!(e.contains("same grading"), "{e}");
    let ok = mapped(&kirsch(1.0, 10.0, 2, 1.0), ElementKind::Quad4).unwrap();
    assert_eq!(ok.n_elems(), 8);
}

#[test]
fn an_elliptic_edge_takes_the_short_way_across_the_negative_x_axis() {
    let (i, o) = (0.5 / 2.0f64.sqrt(), 1.0 / 2.0f64.sqrt());
    let sector = |n: usize| {
        vec![block(
            [[-i, i], [-o, o], [-o, -o], [-i, -i]],
            [
                Curve::Line,
                Curve::Ellipse { center: [0.0, 0.0], semi_axes: [1.0, 1.0] },
                Curve::Line,
                Curve::Ellipse { center: [0.0, 0.0], semi_axes: [0.5, 0.5] },
            ],
            [n, n],
            [1.0, 1.0],
            ["", "outer", "", "inner"],
        )]
    };
    let m = mapped(&sector(4), ElementKind::Quad8).unwrap();
    m.validate().unwrap();
    assert!(min_element_measure(&m) > 0.0, "the arc runs counter-clockwise through (-1, 0)");
    assert!(face_set_nodes(&m, "outer").iter().all(|&j| (radius(m.node(j)) - 1.0).abs() < 1e-12));
    assert!(face_set_nodes(&m, "inner").iter().all(|&j| (radius(m.node(j)) - 0.5).abs() < 1e-12));
    assert!(m.coords.chunks_exact(3).any(|p| p[0] < -0.9), "the block reaches past (-1, 0)");
    let exact = PI / 4.0 * (1.0 - 0.25);
    let err = |n: usize| (measure(&mapped(&sector(n), ElementKind::Quad8).unwrap()) - exact).abs();
    assert!(err(4) / err(8) > 3.5, "errors {} {}", err(4), err(8));
}

// ---- sweep: extrude and revolve --------------------------------------------------------------

/// Serendipity shape function `i` of a hex8 or hex20 at the reference point `x`.
fn hex_shape(kind: ElementKind, i: usize, x: [f64; 3]) -> f64 {
    if i < 8 {
        let r = HEX_REF[i];
        let p = (0..3).map(|k| 1.0 + x[k] * r[k]).product::<f64>() / 8.0;
        match kind {
            ElementKind::Hex8 => p,
            _ => p * ((0..3).map(|k| x[k] * r[k]).sum::<f64>() - 2.0),
        }
    } else {
        let [a, b] = kind.edges()[i - 8];
        let r = mean(&[HEX_REF[a as usize], HEX_REF[b as usize]]);
        let z = (0..3).find(|&k| r[k] == 0.0).expect("a mid-edge node is centred on one axis");
        0.25 * (1.0 - x[z] * x[z]) * (0..3).filter(|&k| k != z).map(|k| 1.0 + x[k] * r[k]).product::<f64>()
    }
}

/// Volume by 3×3×3 Gauss quadrature of the isoparametric map, so a hex20's curved faces count.
/// The Jacobian is a central difference of the map, good to about 1e-10 of the volume.
fn iso_volume(m: &Mesh) -> f64 {
    let g = [-libm::sqrt(0.6), 0.0, libm::sqrt(0.6)];
    let w = [5.0 / 9.0, 8.0 / 9.0, 5.0 / 9.0];
    let h = 1e-5;
    let mut vol = 0.0;
    for e in 0..m.n_elems() as u32 {
        let kind = m.kind_of(e);
        let nodes: Vec<[f64; 3]> = m.elem_nodes(e).iter().map(|&n| m.node(n)).collect();
        let map = |x: [f64; 3]| {
            let mut p = [0.0; 3];
            for (i, xi) in nodes.iter().enumerate() {
                let n = hex_shape(kind, i, x);
                for k in 0..3 {
                    p[k] += n * xi[k];
                }
            }
            p
        };
        for a in 0..3 {
            for b in 0..3 {
                for c in 0..3 {
                    let x = [g[a], g[b], g[c]];
                    let mut j = [[0.0; 3]; 3];
                    for d in 0..3 {
                        let (mut xp, mut xm) = (x, x);
                        xp[d] += h;
                        xm[d] -= h;
                        let (pp, pm) = (map(xp), map(xm));
                        for k in 0..3 {
                            j[k][d] = (pp[k] - pm[k]) / (2.0 * h);
                        }
                    }
                    vol += w[a] * w[b] * w[c] * det3(j);
                }
            }
        }
    }
    vol
}

/// Every mid-edge node of a quadratic element is the midpoint of its two corners.
fn mid_nodes_are_midpoints(m: &Mesh) -> bool {
    (0..m.n_elems() as u32).all(|e| {
        let kind = m.kind_of(e);
        let n: Vec<[f64; 3]> = m.elem_nodes(e).iter().map(|&i| m.node(i)).collect();
        kind.edges().iter().enumerate().all(|(i, &[a, b])| {
            let mid = mean(&[n[a as usize], n[b as usize]]);
            (0..3).all(|k| (n[kind.n_corners() + i][k] - mid[k]).abs() < 1e-12)
        })
    })
}

fn plate(kind: ElementKind, n: [usize; 3]) -> Mesh {
    Structured { kind, n }.build(|p| [2.0 * p[0], 3.0 * p[1], 0.0])
}

#[test]
fn extruding_a_quad_mesh_gives_an_exact_box_of_hexes() {
    let base = plate(ElementKind::Quad4, [2, 3, 1]);
    let m = extrude(&base, 4, 5.0).unwrap();
    m.validate().unwrap();
    assert_eq!(m.blocks[0].kind, ElementKind::Hex8);
    assert_eq!((m.n_nodes(), m.n_elems()), (base.n_nodes() * 5, 6 * 4));
    assert!(min_element_measure(&m) > 0.0);
    assert!((measure(&m) - 30.0).abs() < 1e-12, "{}", measure(&m));
    assert!((iso_volume(&m) - 30.0).abs() < 1e-7, "{}", iso_volume(&m));
    assert_eq!(m.face_sets.keys().collect::<Vec<_>>(), ["bottom", "top", "xmax", "xmin", "ymax", "ymin"]);
    assert_eq!((m.face_sets["bottom"].len(), m.face_sets["top"].len()), (6, 6));
    assert_eq!(m.face_sets["xmin"].len(), 3 * 4);
    assert_eq!(m.face_sets["ymin"].len(), 2 * 4);
    assert!(face_set_nodes(&m, "bottom").iter().all(|&i| m.node(i)[2] == 0.0));
    assert!(face_set_nodes(&m, "top").iter().all(|&i| (m.node(i)[2] - 5.0).abs() < 1e-12));
    assert!(face_set_nodes(&m, "xmin").iter().all(|&i| m.node(i)[0] == 0.0));
    assert_eq!(m.elem_sets["all"].len(), 24);
    assert_eq!(m.boundary_faces().len(), m.face_sets.values().map(Vec::len).sum::<usize>());

    // quad8 gives hex20: the mid-edge nodes of the base on the whole layers, the corner nodes
    // alone on the half layers, and no face-centre node anywhere
    let base8 = plate(ElementKind::Quad8, [2, 3, 1]);
    let m = extrude(&base8, 2, 5.0).unwrap();
    m.validate().unwrap();
    assert_eq!(m.blocks[0].kind, ElementKind::Hex20);
    assert_eq!((base8.n_nodes(), m.n_nodes(), m.n_elems()), (29, 3 * 29 + 2 * 12, 12));
    assert!(min_element_measure(&m) > 0.0);
    assert!((iso_volume(&m) - 30.0).abs() < 1e-7, "{}", iso_volume(&m));
    assert!(mid_nodes_are_midpoints(&m), "a straight extrusion is affine in every direction");
    assert_eq!(m.face_sets["bottom"].len(), 6);
    assert_eq!(m.boundary_faces().len(), m.face_sets.values().map(Vec::len).sum::<usize>());
}

/// A meridian section of the Lamé cylinder: `x = r` from `a` to `b`, `y = z` from 0 to `h`.
fn section(kind: ElementKind, n: [usize; 3], a: f64, b: f64, h: f64) -> Mesh {
    Structured { kind, n }.build(|p| [a + p[0] * (b - a), p[1] * h, 0.0])
}

#[test]
fn revolving_a_section_converges_to_the_cylinder_volume() {
    let (a, b, h) = (0.1, 0.2, 0.1);
    let quarter = PI * (b * b - a * a) * h / 4.0;
    let err = |kind, n: usize| {
        let m = revolve(&section(kind, [2, 1, 1], a, b, h), n, 90.0).unwrap();
        assert!(min_element_measure(&m) > 0.0, "a revolved counter-clockwise section stays positive");
        (iso_volume(&m) - quarter).abs()
    };
    let (e2, e4) = (err(ElementKind::Quad4, 2), err(ElementKind::Quad4, 4));
    assert!(e4 < 0.03 * quarter && e2 / e4 > 3.5, "hex8 errors {e2} {e4}");
    let (q2, q4) = (err(ElementKind::Quad8, 2), err(ElementKind::Quad8, 4));
    assert!(q4 < 1e-4 * quarter && q2 / q4 > 10.0, "hex20 errors {q2} {q4}");
    assert!(q4 < e4 / 100.0, "mid-nodes on the arc beat straight chords by two orders");

    let m = revolve(&section(ElementKind::Quad8, [2, 1, 1], a, b, h), 4, 90.0).unwrap();
    m.validate().unwrap();
    // every node sits on the cylinder radius its base node had, mid-nodes at the half angle
    for i in 0..m.n_nodes() as u32 {
        let r = radius(m.node(i));
        assert!(r > a - 1e-12 && r < b + 1e-12, "{r}");
    }
    assert_eq!(m.face_sets.keys().collect::<Vec<_>>(), ["theta0", "theta1", "xmax", "xmin", "ymax", "ymin"]);
    assert_eq!((m.face_sets["theta0"].len(), m.face_sets["theta1"].len()), (2, 2));
    assert!(face_set_nodes(&m, "theta0").iter().all(|&i| m.node(i)[1].abs() < 1e-12));
    assert!(face_set_nodes(&m, "theta1").iter().all(|&i| m.node(i)[0].abs() < 1e-12));
    assert!(face_set_nodes(&m, "xmax").iter().all(|&i| (radius(m.node(i)) - b).abs() < 1e-12));
    assert!(face_set_nodes(&m, "xmin").iter().all(|&i| (radius(m.node(i)) - a).abs() < 1e-12));
    assert_eq!(m.boundary_faces().len(), m.face_sets.values().map(Vec::len).sum::<usize>());
}

#[test]
fn a_full_revolution_merges_its_seam() {
    let (a, b, h) = (0.1, 0.2, 0.1);
    let base = section(ElementKind::Quad4, [2, 1, 1], a, b, h);
    let m = revolve(&base, 8, 360.0).unwrap();
    m.validate().unwrap();
    assert_eq!(m.n_nodes(), 8 * base.n_nodes(), "the last slice is the first one again");
    assert_eq!(m.n_elems(), 8 * base.n_elems());
    assert!(min_element_measure(&m) > 0.0);
    assert!(!m.face_sets.contains_key("theta0") && !m.face_sets.contains_key("theta1"));
    assert_eq!(m.face_sets.keys().collect::<Vec<_>>(), ["xmax", "xmin", "ymax", "ymin"]);
    // a closed tube has no free end: every boundary face is named
    assert_eq!(m.boundary_faces().len(), m.face_sets.values().map(Vec::len).sum::<usize>());
    let exact = PI * (b * b - a * a) * h;
    // eight straight-chord slices under-fill the tube by (1 - (n/2pi) sin(2pi/n)) = 10 %
    assert!((iso_volume(&m) / exact - 0.9003).abs() < 1e-3, "{}", iso_volume(&m) / exact);
    let base8 = section(ElementKind::Quad8, [2, 1, 1], a, b, h);
    let q = revolve(&base8, 6, 360.0).unwrap();
    q.validate().unwrap();
    assert_eq!(
        q.n_nodes(),
        6 * (base8.n_nodes() + 3 * 2),
        "whole slices carry the base's mid-nodes, half slices only its corners"
    );
    assert!((iso_volume(&q) - exact).abs() < 3e-3 * exact, "{}", iso_volume(&q) / exact);
}

#[test]
fn sweeps_refuse_what_they_cannot_sweep() {
    let base = plate(ElementKind::Quad4, [1, 1, 1]);
    assert!(extrude(&cube(ElementKind::Hex8, [1, 1, 1]), 1, 1.0).unwrap_err().0.contains("2D base mesh"));
    let mut two = plate(ElementKind::Quad4, [1, 1, 1]);
    two.blocks.push(ElementBlock { kind: ElementKind::Quad4, conn: two.blocks[0].conn.clone(), first_elem: 1 });
    assert!(extrude(&two, 1, 1.0).unwrap_err().0.contains("one element kind"));
    assert!(extrude(&plate(ElementKind::Tri3, [1, 1, 1]), 1, 1.0).unwrap_err().0.contains("quad4 or quad8"));
    assert!(extrude(&base, 0, 1.0).unwrap_err().0.contains("at least one layer"));
    assert!(extrude(&base, 1, 0.0).unwrap_err().0.contains("must be finite and positive"));
    assert!(revolve(&cube(ElementKind::Hex8, [1, 1, 1]), 1, 90.0).unwrap_err().0.contains("2D base mesh"));
    assert!(revolve(&base, 0, 90.0).unwrap_err().0.contains("at least one segment"));
    assert!(revolve(&base, 1, 400.0).unwrap_err().0.contains("in (0, 360]"));
    assert!(revolve(&base, 1, 0.0).unwrap_err().0.contains("in (0, 360]"));
    // the base touches x = 0, which a revolution about z cannot mesh
    assert!(revolve(&base, 4, 90.0).unwrap_err().0.contains("butterfly block set"));
}

// ---- free 2D triangles -----------------------------------------------------------------------

/// A 10 x 10 plate with a circular hole of radius `r` at its centre, every edge tagged.
fn plate_with_hole(r: f64) -> Sketch {
    let mut s = Sketch::rect(10.0, 10.0);
    s.holes.push(Sketch::circle([5.0, 5.0], r, "hole"));
    s
}

/// The area of the polygon the mesher actually triangulates: the sampled loops, not the arcs.
fn sampled_area(sketch: &Sketch, chord_tol: f64) -> f64 {
    sketch.loops(chord_tol).unwrap().iter().map(|l| l.signed_area()).sum()
}

fn triangle_area(m: &Mesh, e: u32) -> f64 {
    let [a, b, c] = [m.node(m.elem_nodes(e)[0]), m.node(m.elem_nodes(e)[1]), m.node(m.elem_nodes(e)[2])];
    0.5 * ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).abs()
}

fn triangle_centroid(m: &Mesh, e: u32) -> [f64; 2] {
    let nodes = m.elem_nodes(e);
    let p = [m.node(nodes[0]), m.node(nodes[1]), m.node(nodes[2])];
    [(p[0][0] + p[1][0] + p[2][0]) / 3.0, (p[0][1] + p[1][1] + p[2][1]) / 3.0]
}

#[test]
fn the_free_mesher_fills_a_plate_with_a_hole_and_keeps_every_tag() {
    let sketch = plate_with_hole(1.0);
    for quadratic in [false, true] {
        let m = free(&sketch, 1.0, quadratic, &[]).unwrap();
        m.validate().unwrap();
        assert_eq!(m.blocks[0].kind, if quadratic { ElementKind::Tri6 } else { ElementKind::Tri3 });
        assert!(min_element_measure(&m) > 0.0, "every triangle is counter-clockwise");
        // the mesh is exactly the sampled polygon, hole carved
        assert!((measure(&m) - sampled_area(&sketch, 0.1)).abs() < 1e-12, "{}", measure(&m));
        assert_eq!(m.elem_sets["all"].len(), m.n_elems());
        assert_eq!(m.face_sets.keys().collect::<Vec<_>>(), ["hole", "xmax", "xmin", "ymax", "ymin"]);
        for (name, faces) in &m.face_sets {
            assert!(!faces.is_empty(), "{name}");
        }
        // the tagged edges are exactly the boundary of the mesh, and nothing else
        assert_eq!(m.boundary_faces().len(), m.face_sets.values().map(Vec::len).sum::<usize>());
        assert!(face_set_nodes(&m, "xmin").iter().all(|&n| m.node(n)[0] == 0.0));
        assert!(face_set_nodes(&m, "hole").iter().all(|&n| {
            let p = m.node(n);
            (libm::hypot(p[0] - 5.0, p[1] - 5.0) - 1.0).abs() < 0.1
        }));
    }
    // tri6 mid-nodes are the midpoints of the Abaqus edges, in the Abaqus order
    let m = free(&sketch, 2.0, true, &[]).unwrap();
    assert!(mid_nodes_are_midpoints(&m), "weka's edge_nodes are permuted to [e2, e0, e1]");
    // the same input twice is the same mesh, to the last bit
    assert_eq!(free(&sketch, 2.0, true, &[]).unwrap(), m);
}

#[test]
fn a_refine_box_makes_smaller_triangles_where_it_covers() {
    let sketch = plate_with_hole(1.0);
    let box_ = RefineBox { min: [3.0, 3.0], max: [7.0, 7.0], size: 0.4 };
    let m = free(&sketch, 2.0, false, std::slice::from_ref(&box_)).unwrap();
    m.validate().unwrap();
    assert!(min_element_measure(&m) > 0.0);
    assert!((measure(&m) - sampled_area(&sketch, 0.2)).abs() < 1e-12);
    let inside = |e: u32| {
        let c = mean(&corners(&m, e));
        (3.0..=7.0).contains(&c[0]) && (3.0..=7.0).contains(&c[1])
    };
    let area = |e: u32| corner_measure(m.kind_of(e), &corners(&m, e));
    let biggest_in = (0..m.n_elems() as u32).filter(|&e| inside(e)).map(area).fold(0.0, f64::max);
    let biggest_out = (0..m.n_elems() as u32).filter(|&e| !inside(e)).map(area).fold(0.0, f64::max);
    let mean = |f: fn(bool) -> bool| {
        let es: Vec<u32> = (0..m.n_elems() as u32).filter(|&e| f(inside(e))).collect();
        es.iter().map(|&e| area(e)).sum::<f64>() / es.len() as f64
    };
    let (mean_in, mean_out) = (mean(|i| i), mean(|i| !i));
    // The bound is imposed on the coarse triangles whose centroid was in the box, so a child of
    // a coarse triangle centred just outside can still straddle the wall: the average holds the
    // box's own bound, the largest single triangle need not.
    assert!(mean_in < 2.0 * 0.5 * 0.4 * 0.4, "inside averages near the box's area bound: {mean_in}");
    assert!(mean_out > 4.0 * mean_in, "outside stays coarse: {mean_out} vs {mean_in}");
    assert!(biggest_out > 2.0 * biggest_in, "and so does the largest: {biggest_out} vs {biggest_in}");
    assert!(free(&sketch, 2.0, false, &[]).unwrap().n_elems() < m.n_elems());
}

#[test]
fn overlapping_refine_boxes_choose_the_finer_bound_independent_of_order() {
    let sketch = Sketch::rect(10.0, 10.0);
    let coarse = RefineBox { min: [2.0, 2.0], max: [8.0, 8.0], size: 1.0 };
    let fine = RefineBox { min: [3.0, 3.0], max: [7.0, 7.0], size: 0.25 };
    let runs = [vec![coarse.clone(), fine.clone()], vec![fine, coarse]];
    let mut meshes = Vec::new();
    let mut summaries = Vec::new();
    for boxes in runs {
        let m = free(&sketch, 2.0, false, &boxes).unwrap();
        m.validate().unwrap();
        let mut overlap_sum = 0.0;
        let mut overlap_count = 0;
        let mut outside_max: f64 = 0.0;
        for e in 0..m.n_elems() as u32 {
            let c = triangle_centroid(&m, e);
            let area = triangle_area(&m, e);
            if (3.0..=7.0).contains(&c[0]) && (3.0..=7.0).contains(&c[1]) {
                overlap_sum += area;
                overlap_count += 1;
            }
            if !(2.0..=8.0).contains(&c[0]) || !(2.0..=8.0).contains(&c[1]) {
                outside_max = outside_max.max(area);
            }
        }
        assert!(overlap_count > 0, "nested refinement produced no overlap triangles");
        summaries.push((m.n_elems(), overlap_sum / overlap_count as f64, outside_max));
        meshes.push(m);
    }
    assert_eq!(meshes[0], meshes[1], "box order changes mesh points or connectivity");
    assert_eq!(summaries[0], summaries[1], "box order changes measured areas");
    for (elements, overlap_mean, outside_max) in summaries {
        assert!(elements > 100, "nested refinement should add elements");
        assert!(overlap_mean < 0.5 * 0.25 * 0.25, "fine overlap mean area is {overlap_mean}");
        assert!(outside_max > 0.9 * 0.5 * 2.0 * 2.0, "outside boxes lost the global coarse behavior: {outside_max}");
    }
}

#[test]
fn a_hole_whose_centroid_lies_outside_it_is_still_carved() {
    // an L-shaped hole: the mean of its corners falls in the notch, outside the hole
    let mut s = Sketch::rect(6.0, 6.0);
    s.holes.push(vec![
        Segment::Line { to: [4.0, 1.0], tag: Some("ell".into()) },
        Segment::Line { to: [4.0, 2.0], tag: Some("ell".into()) },
        Segment::Line { to: [2.0, 2.0], tag: Some("ell".into()) },
        Segment::Line { to: [2.0, 4.0], tag: Some("ell".into()) },
        Segment::Line { to: [1.0, 4.0], tag: Some("ell".into()) },
        Segment::Line { to: [1.0, 1.0], tag: Some("ell".into()) },
    ]);
    let l = &s.loops(0.1).unwrap()[1];
    let n = l.pts.len() as f64;
    let c = [l.pts.iter().map(|p| p[0]).sum::<f64>() / n, l.pts.iter().map(|p| p[1]).sum::<f64>() / n];
    assert!(!l.contains(c), "the centroid {c:?} is in the notch, so the seed comes off an edge");
    let m = free(&s, 1.0, false, &[]).unwrap();
    m.validate().unwrap();
    assert!((measure(&m) - sampled_area(&s, 0.1)).abs() < 1e-12, "the L is carved out exactly");
    assert!(!m.face_sets["ell"].is_empty());
}

#[test]
fn the_free_mesher_refuses_a_bad_size_or_a_bad_sketch() {
    let s = plate_with_hole(1.0);
    assert!(free(&s, 0.0, false, &[]).unwrap_err().0.contains("must be finite and positive"));
    assert!(free(&s, f64::NAN, false, &[]).unwrap_err().0.contains("must be finite and positive"));
    let bad = RefineBox { min: [0.0, 0.0], max: [1.0, 1.0], size: -1.0 };
    assert!(free(&s, 1.0, false, &[bad]).unwrap_err().0.contains("refine box 0 has size -1"));
    let one = Sketch { outer: vec![Segment::Line { to: [1.0, 0.0], tag: None }], holes: vec![] };
    assert!(free(&one, 1.0, false, &[]).unwrap_err().0.contains("two segments"));
    // a hole that covers the whole outer loop carves everything: no triangle, and the refine
    // pass has nothing to refine, so weka's own failure comes back as a GeomError
    let mut all_hole = Sketch::rect(4.0, 4.0);
    all_hole.holes.push(Sketch::rect(4.0, 4.0).outer);
    assert!(free(&all_hole, 1.0, false, &[]).unwrap_err().0.contains("produced no triangle"));
    let box_ = RefineBox { min: [0.0, 0.0], max: [4.0, 4.0], size: 0.5 };
    assert!(free(&all_hole, 1.0, false, &[box_]).unwrap_err().0.contains("3 input points"));
}

#[test]
fn transformed_sheets_mesh_in_world_space_with_oriented_hole_boundaries() {
    use femlab_geometry::{free_sheet, Affine3, Shape};
    let mut sketch = Sketch::rect(2.0, 2.0);
    sketch.holes.push(vec![
        Segment::Line { to: [0.5, 0.5], tag: Some("hole".into()) },
        Segment::Line { to: [1.5, 0.5], tag: Some("hole".into()) },
        Segment::Line { to: [1.5, 1.5], tag: Some("hole".into()) },
        Segment::Line { to: [0.5, 1.5], tag: Some("hole".into()) },
    ]);
    let shape = Shape::Transform {
        at: Affine3 { translate: [5.0, 7.0, 0.0], rotate: [0.0, 0.0, 90.0], scale: [2.0, 3.0, 1.0] },
        shape: Box::new(Shape::Named { name: "section".into(), shape: Box::new(Shape::Sheet { sketch }) }),
    };
    for quadratic in [false, true] {
        let mut previous_elements = 0;
        for size in [0.8, 0.4, 0.2] {
            let m = free_sheet(&shape, size, quadratic, &[]).unwrap();
            m.validate().unwrap();
            assert!((measure(&m) - 18.0).abs() < 1e-10, "(4−1)*2*3 m²");
            assert!(min_element_measure(&m) > 0.0, "every triangle has positive signed Jacobian");
            assert!(m.n_elems() > previous_elements);
            previous_elements = m.n_elems();
            assert_eq!(m.boundary_faces().len(), m.face_sets.values().map(Vec::len).sum::<usize>());
            assert_eq!(
                m.face_sets.keys().collect::<Vec<_>>(),
                ["section.hole", "section.xmax", "section.xmin", "section.ymax", "section.ymin"]
            );
            for e in 0..m.n_elems() as u32 {
                let centre = mean(&m.elem_nodes(e)[..3].iter().map(|&n| m.node(n)).collect::<Vec<_>>());
                assert!(centre[0] >= -1.0 && centre[0] <= 5.0 && centre[1] >= 7.0 && centre[1] <= 11.0);
                assert!(
                    !(centre[0] > 0.5 && centre[0] < 3.5 && centre[1] > 8.0 && centre[1] < 10.0),
                    "hole contains no triangle"
                );
                assert!(
                    corner_measure(m.kind_of(e), &corners(&m, e)) <= size * size / 2.0 * 1.000001,
                    "size is measured after scaling"
                );
            }
            for (tag, axis, coordinate) in [
                ("section.xmin", 1, 7.0),
                ("section.xmax", 1, 11.0),
                ("section.ymin", 0, 5.0),
                ("section.ymax", 0, -1.0),
            ] {
                assert!(face_set_nodes(&m, tag).iter().all(|&n| (m.node(n)[axis] - coordinate).abs() < 1e-12));
            }
            if quadratic {
                assert!(mid_nodes_are_midpoints(&m));
            }
        }
    }
    let box_ = RefineBox { min: [3.5, 7.0], max: [5.0, 8.0], size: 0.1 };
    let refined = free_sheet(&shape, 0.8, false, &[box_]).unwrap();
    let (mut inside, mut outside) = (Vec::new(), Vec::new());
    for e in 0..refined.n_elems() as u32 {
        let c = mean(&refined.elem_nodes(e).iter().map(|&n| refined.node(n)).collect::<Vec<_>>());
        let area = corner_measure(refined.kind_of(e), &corners(&refined, e));
        if c[0] > 3.5 && c[1] < 8.0 {
            inside.push(area);
        } else {
            outside.push(area);
        }
    }
    let mean_inside = inside.iter().sum::<f64>() / inside.len() as f64;
    let mean_outside = outside.iter().sum::<f64>() / outside.len() as f64;
    assert!(mean_inside < 0.01 && mean_outside > 4.0 * mean_inside, "refine box uses transformed world coordinates");
}

#[test]
fn transformed_curved_holes_resample_as_world_element_size_decreases() {
    use femlab_geometry::{free_sheet, Affine3, Shape};
    let shape = Shape::Transform {
        at: Affine3 { translate: [35.0, -2.0, 0.0], rotate: [0.0, 0.0, 90.0], scale: [2.0, 3.0, 1.0] },
        shape: Box::new(Shape::Sheet { sketch: plate_with_hole(1.0) }),
    };
    let exact = 600.0 - 6.0 * PI; // 20×30 rectangle less an ellipse with radii 3 and 2.
    let mut previous_error = f64::INFINITY;
    for size in [2.0, 1.0, 0.5] {
        let m = free_sheet(&shape, size, true, &[]).unwrap();
        let error = measure(&m) - exact;
        assert!(error > 0.0 && error < previous_error && error < 0.4 * PI * size, "{size}: {error}");
        previous_error = error;
        assert!(min_element_measure(&m) > 0.0);
        for n in face_set_nodes(&m, "hole") {
            let p = m.node(n);
            let radius = (((p[0] - 20.0) / 3.0).powi(2) + ((p[1] - 8.0) / 2.0).powi(2)).sqrt();
            assert!((radius - 1.0).abs() <= 0.1 * size / 3.0 + 1e-12, "ellipse boundary chord bound");
        }
    }
}

#[test]
fn free_sheets_reject_unsupported_transforms_explicitly() {
    use femlab_geometry::{free_sheet, Affine3, Shape};
    let sheet = Shape::Sheet { sketch: Sketch::rect(1.0, 1.0) };
    for at in [
        Affine3 { translate: [0.0, 0.0, 1.0], ..Default::default() },
        Affine3 { rotate: [15.0, 0.0, 0.0], ..Default::default() },
        Affine3 { rotate: [0.0, 15.0, 0.0], ..Default::default() },
    ] {
        let shape = Shape::Transform { at, shape: Box::new(sheet.clone()) };
        assert!(free_sheet(&shape, 0.25, false, &[]).unwrap_err().0.contains("xy plane"));
    }
    let bad_scale = Shape::Transform {
        at: Affine3 { scale: [0.0, 1.0, 1.0], ..Default::default() },
        shape: Box::new(sheet.clone()),
    };
    assert!(free_sheet(&bad_scale, 0.25, false, &[]).unwrap_err().0.contains("scale factors must be positive"));
    let inner = Shape::Transform { at: Affine3::default(), shape: Box::new(sheet.clone()) };
    let nested =
        Shape::Transform { at: Affine3 { translate: [1.0, 0.0, 0.0], ..Default::default() }, shape: Box::new(inner) };
    assert!(free_sheet(&nested, 0.25, false, &[]).unwrap_err().0.contains("nested transforms"));
    let boolean = Shape::Union { shapes: vec![sheet] };
    assert!(free_sheet(&boolean, 0.25, false, &[]).unwrap_err().0.contains("booleans of 2D"));
}

// ---- sketch validation: no degenerate or crossing input ever reaches weka (issues #5, #54) ----

fn line(to: [f64; 2]) -> Segment {
    Segment::Line { to, tag: None }
}

/// The plate-with-hole tutorial sketch that panicked weka: the hole's fourth arc ends where its
/// first one does, so the loop closes with a full circle laid over the other three arcs.
fn full_circle_hole() -> Sketch {
    let c = [50.0, 40.0];
    let arc = |to: [f64; 2]| Segment::Arc { center: c, to, ccw: true, tag: Some("hole".into()) };
    Sketch {
        outer: Sketch::rect(100.0, 80.0).outer,
        holes: vec![vec![arc([35.0, 40.0]), arc([50.0, 25.0]), arc([65.0, 40.0]), arc([35.0, 40.0])]],
    }
}

#[test]
fn the_full_circle_arc_that_panicked_weka_is_now_a_located_error() {
    let s = full_circle_hole();
    let e = s.check().unwrap_err();
    assert_eq!(e.where_, "holes[0][3]");
    assert!(e.cause.contains("a full circle"), "{}", e.cause);
    assert!(e.suggestion.contains("split the full-circle arc into two arcs"), "{}", e.suggestion);
    // the mesher refuses it instead of panicking, and says where
    let g = free(&s, 5.0, true, &[]).unwrap_err().0;
    assert!(g.contains("holes[0][3]") && g.contains("full circle"), "{g}");
    // the same hole written as the two arcs a full circle needs meshes fine
    let good =
        Sketch { outer: Sketch::rect(100.0, 80.0).outer, holes: vec![Sketch::circle([50.0, 40.0], 15.0, "hole")] };
    good.check().unwrap();
    assert!(free(&good, 5.0, false, &[]).unwrap().n_elems() > 0);
}

#[test]
fn a_degenerate_or_crossing_sketch_names_its_loop_and_segment() {
    // a zero-length line: segment 2 repeats the corner segment 1 ends at (issue #5)
    let mut zero = Sketch::rect(4.0, 4.0);
    zero.outer.insert(2, line([4.0, 4.0]));
    let e = zero.check().unwrap_err();
    assert_eq!(e.where_, "outer[2]");
    assert!(e.cause.contains("segment 2 of the outer loop has zero length"), "{}", e.cause);
    assert!(e.suggestion.contains("remove segment 2"), "{}", e.suggestion);
    assert!(free(&zero, 1.0, false, &[]).unwrap_err().0.contains("zero length"));

    // a loop that comes back to a corner it already visited, with segments in between
    let eight = Sketch {
        outer: vec![line([2.0, 0.0]), line([2.0, 2.0]), line([0.0, 2.0]), line([2.0, 0.0]), line([0.0, 0.0])],
        holes: vec![],
    };
    let e = eight.check().unwrap_err();
    assert_eq!(e.where_, "outer[3]");
    assert!(e.cause.contains("returns to (2, 0) at segment 3"), "{}", e.cause);
    assert!(e.suggestion.contains("split the loop"), "{}", e.suggestion);

    // a bow tie: edge 1 and edge 3 cross at (1, 1), and no corner repeats
    let bow =
        Sketch { outer: vec![line([2.0, 0.0]), line([0.0, 2.0]), line([2.0, 2.0]), line([0.0, 0.0])], holes: vec![] };
    let e = bow.check().unwrap_err();
    assert_eq!(e.where_, "outer[3]");
    assert!(e.cause.contains("crosses itself: segment 1 and segment 3"), "{}", e.cause);
    assert!(e.suggestion.contains("does not cross segment 1"), "{}", e.suggestion);

    // a hole that straddles the outer boundary crosses it
    let mut straddle = Sketch::rect(4.0, 4.0);
    straddle.holes.push(vec![line([5.0, 1.0]), line([5.0, 3.0]), line([3.0, 3.0]), line([3.0, 1.0])]);
    let e = straddle.check().unwrap_err();
    assert_eq!(e.where_, "holes[0][0]");
    assert!(e.cause.contains("of the holes[0] loop crosses segment"), "{}", e.cause);
    assert!(e.suggestion.contains("never cross"), "{}", e.suggestion);

    // a hole nowhere near the outer loop is outside it
    let mut away = Sketch::rect(4.0, 4.0);
    away.holes.push(vec![line([11.0, 10.0]), line([11.0, 11.0]), line([10.0, 11.0]), line([10.0, 10.0])]);
    let e = away.check().unwrap_err();
    assert_eq!(e.where_, "holes[0]");
    assert!(e.cause.contains("outside the outer loop"), "{}", e.cause);
    assert!(e.suggestion.contains("inside the outer loop"), "{}", e.suggestion);

    // a coordinate that is not a number
    let nan = Sketch { outer: vec![line([1.0, 0.0]), line([f64::NAN, 1.0]), line([0.0, 0.0])], holes: vec![] };
    let e = nan.check().unwrap_err();
    assert_eq!(e.where_, "outer[1]");
    assert!(e.cause.contains("not a finite number"), "{}", e.cause);
    assert!(e.suggestion.contains("finite coordinates"), "{}", e.suggestion);

    // loops too short to bound an area, located at the loop
    let two = Sketch { outer: vec![line([1.0, 0.0]), line([0.0, 0.0])], holes: vec![] };
    let e = two.check().unwrap_err();
    assert_eq!(e.where_, "outer");
    assert!(e.cause.contains("three distinct points (the outer loop)"), "{}", e.cause);
    let mut short_hole = Sketch::rect(4.0, 4.0);
    short_hole.holes.push(vec![line([1.0, 1.0])]);
    assert_eq!(short_hole.check().unwrap_err().where_, "holes[0]");

    // a sketch a mesher can use passes, and so does a hole that only touches the outer loop
    Sketch::rect(4.0, 4.0).check().unwrap();
    plate_with_hole(1.0).check().unwrap();
    let mut touching = Sketch::rect(4.0, 4.0);
    touching.holes.push(vec![line([3.0, 0.0]), line([3.0, 1.0]), line([1.0, 1.0]), line([1.0, 0.0])]);
    touching.check().unwrap();
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]
    /// Whatever the segments say, the free mesher returns: `weka` panics on degenerate and
    /// crossing input, so `Sketch::check` has to catch every such sketch first (issue #5).
    /// Any `Err` is a pass here; a panic is the failure.
    #[test]
    fn a_random_sketch_never_panics_the_free_mesher(
        outer in prop::collection::vec(any_segment(), 0..6),
        holes in prop::collection::vec(prop::collection::vec(any_segment(), 0..5), 0..3),
    ) {
        let s = Sketch { outer, holes };
        // The property is that these three calls return at all. Any `Err` is a pass.
        let _ = s.check();
        let _ = free(&s, 1.0, false, &[]);
        let _ = free(&s, 0.7, true, &[RefineBox { min: [-1.0, -1.0], max: [1.0, 1.0], size: 0.4 }]);
    }
}

fn any_segment() -> impl Strategy<Value = Segment> {
    prop_oneof![
        (-4.0f64..4.0, -4.0f64..4.0).prop_map(|(x, y)| Segment::Line { to: [x, y], tag: None }),
        // quarter-turn end points, so the sampler gets past `arc_radius` often enough for the
        // loops to be sampled at all, and coincident points come up often enough to matter
        (-4.0f64..4.0, -4.0f64..4.0, 0.2f64..4.0, 0usize..4, any::<bool>()).prop_map(|(cx, cy, r, q, ccw)| {
            let d = [[1.0, 0.0], [0.0, 1.0], [-1.0, 0.0], [0.0, -1.0]][q];
            Segment::Arc { center: [cx, cy], to: [cx + r * d[0], cy + r * d[1]], ccw, tag: None }
        }),
    ]
}

// ---- line members ----------------------------------------------------------------------------

fn truss(points: &[[f64; 3]], members: &[[u32; 2]], divisions: u32) -> Mesh {
    line_mesher(points, members, divisions, ElementKind::Truss2).expect("a valid line body")
}

#[test]
fn truss2_tables_describe_a_two_node_line_member() {
    let k = ElementKind::Truss2;
    assert_eq!((k.n_nodes(), k.n_corners(), k.dim(), k.n_faces()), (2, 2, 1, 0));
    assert_eq!(k.edges(), &[[0, 1]]);
    // A member has no face, so no face table entry and no face load can name one.
    assert!(k.face_nodes(0).is_empty());
    assert_eq!(k.face_kind(), FaceKind::Line2);
    assert_eq!(serde_json::to_string(&k).unwrap(), "\"truss2\"");
    assert_eq!(serde_json::from_str::<ElementKind>("\"truss2\"").unwrap(), k);
}

#[test]
fn the_line_mesher_divides_every_member_and_names_every_joint() {
    // A two-bar planar truss: joints 0, 1, 2 with members 0-2 and 1-2.
    let pts = [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [1.0, 1.0, 0.0]];
    let m = truss(&pts, &[[0, 2], [1, 2]], 1);
    m.validate().unwrap();
    assert_eq!((m.dim, m.n_nodes(), m.n_elems()), (3, 3, 2));
    assert_eq!(m.blocks[0].conn, [0, 2, 1, 2]);
    assert_eq!(m.node_sets.keys().collect::<Vec<_>>(), ["p0", "p1", "p2"]);
    assert_eq!(m.node_sets["p2"], [2]);
    // A member has no boundary face and no skin triangle: the segments are all it draws.
    assert!(m.boundary_faces().is_empty());
    let s = m.surface();
    assert!(s.triangles.is_empty() && s.edges.is_empty());
    assert_eq!(s.lines, [[0, 2], [1, 2]]);
    assert_eq!(s.line_elem, [0, 1]);

    // Subdivision adds interior nodes after the joints, in member order, evenly spaced.
    let m = truss(&pts, &[[0, 1]], 4);
    m.validate().unwrap();
    assert_eq!((m.n_nodes(), m.n_elems()), (6, 4));
    assert_eq!(m.blocks[0].conn, [0, 3, 3, 4, 4, 5, 5, 1]);
    assert_eq!(m.node(4), [1.0, 0.0, 0.0]);
    assert_eq!(m.node_sets.len(), 3);
    // Total member length is preserved exactly by the subdivision.
    let total: f64 = (0..m.n_elems() as u32)
        .map(|e| {
            let c = corners(&m, e);
            dot(sub(c[1], c[0]), sub(c[1], c[0])).sqrt()
        })
        .sum();
    assert!((total - 2.0).abs() < 1e-15, "{total}");
}

#[test]
fn the_line_mesher_rejects_every_ill_formed_body() {
    let ok = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 0.0, 0.0]];
    /// Points, members, divisions and the cause the mesher should name.
    type BadLine<'a> = (&'a [[f64; 3]], &'a [[u32; 2]], u32, &'a str);
    let cases: [BadLine<'_>; 6] = [
        (&ok[..1], &[[0, 1]], 1, "at least 2 points"),
        (&[[0.0, 0.0, 0.0], [f64::NAN, 0.0, 0.0]], &[[0, 1]], 1, "non-finite point"),
        (&ok[..2], &[], 1, "at least one member"),
        (&ok[..2], &[[0, 1]], 0, "divisions must be at least 1"),
        (&ok[..2], &[[0, 2]], 1, "references point 2 but there are 2 points"),
        (&ok, &[[1, 2]], 1, "zero length"),
    ];
    for (points, members, divisions, want) in cases {
        let e = line_mesher(points, members, divisions, ElementKind::Truss2).unwrap_err();
        assert!(e.0.contains(want), "got '{}', wanted '{want}'", e.0);
    }
    let e = line_mesher(&ok[..2], &[[1, 1]], 1, ElementKind::Truss2).unwrap_err();
    assert!(e.0.contains("joins point 1 to itself"), "{}", e.0);
}

#[test]
fn a_polyline_shape_has_no_interior_and_no_solid() {
    let shape = Shape::Polyline { points: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]], members: vec![[0, 1]], divisions: 2 };
    assert_eq!(shape.dim(), 1);
    shape.validate().expect("a straight member");
    // A curve has no volume for a point to be inside of, not even a point on it.
    assert!(!shape.contains([0.5, 0.0, 0.0]).unwrap());
    // And it never becomes a Solid: the line mesher is its own geometry.
    let e = Solid::evaluate(&shape).unwrap_err();
    assert!(e.0.contains("no volume"), "{}", e.0);
    // Its validation is the line mesher's, so the Shape and the mesher agree on the cause.
    let bad = Shape::Polyline { points: vec![[0.0; 3]], members: vec![[0, 1]], divisions: 1 };
    assert!(bad.validate().unwrap_err().0.contains("at least 2 points"));
    // A boolean cannot mix dimensions, and the message says all three.
    let mixed = Shape::Union { shapes: vec![shape.clone(), Shape::Box { size: [1.0; 3] }] };
    assert!(mixed.validate().unwrap_err().0.contains("1D line members"));
}

#[test]
fn a_line_block_is_accepted_in_a_3d_mesh_and_refused_in_a_2d_one() {
    let mut m = truss(&[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]], &[[0, 1]], 1);
    m.validate().unwrap();
    m.dim = 2;
    assert!(m.validate().unwrap_err().0.contains("Truss2 in a 2D mesh"));
}

#[test]
fn quality_of_a_straight_member_is_perfect_whatever_its_direction() {
    let m = truss(&[[0.0, 0.0, 0.0], [1.0, 2.0, 3.0], [2.0, 2.0, 3.0]], &[[0, 1], [1, 2]], 2);
    let q = quality(&m, 4);
    assert_eq!(q.min_det_j_ratio, 1.0);
    assert!((q.max_aspect - 1.0).abs() < 1e-12, "{q:?}");
    // A segment has no corner to measure an angle at, so nothing lowers the mesh minimum.
    assert_eq!(q.min_angle_deg, 180.0);
    assert_eq!(q.worst.len(), 4);
}

#[test]
fn merge_coincident_welds_joints_keeps_the_lowest_id_and_leaves_a_clean_mesh_alone() {
    // Two Bodies meeting at one joint: node 1 of the first and node 2 of the second coincide.
    let a = truss(&[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]], &[[0, 1]], 1);
    let mut m = a.clone();
    m.coords.extend([1.0, 0.0, 0.0, 1.0, 1.0, 0.0]);
    m.blocks.push(ElementBlock { kind: ElementKind::Truss2, conn: vec![2, 3], first_elem: 1 });
    m.node_sets.insert("b.p0".into(), vec![2]);
    m.node_sets.insert("b.p1".into(), vec![3]);
    merge_coincident(&mut m, 1e-9);
    m.validate().unwrap();
    assert_eq!(m.n_nodes(), 3);
    assert_eq!(m.blocks[0].conn, [0, 1]);
    // The survivor is the lower id, so the second body's first joint became node 1.
    assert_eq!(m.blocks[1].conn, [1, 2]);
    assert_eq!(m.node_sets["p1"], [1]);
    assert_eq!(m.node_sets["b.p0"], [1]);
    assert_eq!(m.node_sets["b.p1"], [2]);

    // Nothing coincident: the mesh comes back untouched, node ids included.
    let mut clean = a.clone();
    merge_coincident(&mut clean, 1e-9);
    assert_eq!(clean, a);

    // Three coincident nodes collapse to one, and a set naming all three becomes one node.
    let mut triple = a.clone();
    triple.coords.extend([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    triple.node_sets.insert("z".into(), vec![1, 2, 3]);
    merge_coincident(&mut triple, 1e-9);
    assert_eq!(triple.n_nodes(), 2);
    assert_eq!(triple.node_sets["z"], [1]);

    // A node within tolerance of two survivors that sit in different grid cells joins the
    // lower-numbered one, whichever cell the scan reaches first.
    let mut spanning = Mesh {
        dim: 3,
        coords: vec![0.6e-9, 0.0, 0.0, -0.6e-9, 0.0, 0.0, 0.0, 0.0, 0.0],
        blocks: vec![ElementBlock { kind: ElementKind::Truss2, conn: vec![0, 1], first_elem: 0 }],
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::new(),
        face_sets: BTreeMap::new(),
    };
    merge_coincident(&mut spanning, 1e-9);
    assert_eq!(spanning.n_nodes(), 2);
    assert_eq!(spanning.blocks[0].conn, [0, 1]);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]
    /// Finite inputs can overflow when multiplied or added. No such point may reach weka.
    #[test]
    fn overflowing_sheet_transforms_return_errors_before_triangulation(
        scale in 9e307f64..1e308,
        quadratic in any::<bool>(),
    ) {
        use femlab_geometry::{free_sheet, Affine3, Shape, Solid};
        for translate in [0.0, 1e308] {
            let width = if translate == 0.0 { 2.0 } else { 1.0 };
            let shape = Shape::Transform {
                at: Affine3 { scale: [scale, 1.0, 1.0], translate: [translate, 0.0, 0.0], ..Default::default() },
                shape: Box::new(Shape::Sheet { sketch: Sketch::rect(width, 1.0) }),
            };
            prop_assert!(free_sheet(&shape, 1.0, quadratic, &[]).unwrap_err().0.contains("non-finite coordinates"));
            prop_assert!(Solid::evaluate(&shape).unwrap_err().0.contains("non-finite coordinates"));
        }
    }
}

// ---- imported triangle-mesh geometry (#350) ---------------------------------------------------

use femlab_geometry::{Affine3, MAX_TRIANGLES};

/// The tagged boundary of an evaluated Solid, back as a raw soup: what an STL round trip gives.
fn resample(shape: &Shape) -> Shape {
    let s = Solid::evaluate(shape).unwrap();
    let t = s.triangles();
    Shape::Mesh {
        positions: t.positions.clone(),
        triangles: t.triangles.clone(),
        feature_angle: None,
        simplify_below: None,
    }
}

/// The unit cube [0,1]^3 as a soup, wound counter-clockwise seen from outside.
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
    let triangles = quads.iter().flat_map(|q| [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]).collect();
    (positions, triangles)
}

fn mesh_shape(positions: Vec<[f64; 3]>, triangles: Vec<[u32; 3]>) -> Shape {
    Shape::Mesh { positions, triangles, feature_angle: None, simplify_below: None }
}

fn patch_areas(s: &Solid) -> BTreeMap<String, f64> {
    let m = s.triangles();
    let mut out: BTreeMap<String, f64> = BTreeMap::new();
    for (t, tri) in m.triangles.iter().enumerate() {
        let (p, q, r) = (m.positions[tri[0] as usize], m.positions[tri[1] as usize], m.positions[tri[2] as usize]);
        let n = cross(sub(q, p), sub(r, p));
        *out.entry(m.tag_of(t).to_string()).or_default() += 0.5 * libm::sqrt(dot(n, n));
    }
    out
}

#[test]
fn an_imported_cube_is_exact_with_six_named_patches() {
    let (positions, triangles) = cube_soup();
    let s = Solid::evaluate(&mesh_shape(positions, triangles)).unwrap();
    assert_eq!(s.dim(), 3);
    assert!((s.volume() - 1.0).abs() < 1e-12, "{}", s.volume());
    assert!((s.area() - 6.0).abs() < 1e-12);
    assert_eq!(s.bbox(), ([0.0; 3], [1.0; 3]));
    assert_eq!(s.genus(), 0);
    assert_eq!(s.tags(), ["face0", "face1", "face2", "face3", "face4", "face5"]);
    for (_, a) in patch_areas(&s) {
        assert!((a - 1.0).abs() < 1e-12);
    }
    assert!(s.contains([0.5, 0.5, 0.5]));
    assert!(!s.contains([1.5, 0.5, 0.5]));
    assert!(!s.contains([-0.5, 0.5, 0.5]));
    assert!(s.contains([0.125, 0.125, 0.125]));
    assert!(format!("{s:?}").contains("MeshIndex(12 triangles)"));
}

#[test]
fn every_primitive_survives_a_round_trip_through_its_own_triangles() {
    let cases: [(Shape, usize, f64); 4] = [
        (Shape::Box { size: [1.0, 2.0, 3.0] }, 6, 6.0),
        (Shape::Cylinder { radius: 1.0, height: 2.0, segments: Some(64) }, 3, 32.0 * libm::sin(2.0 * PI / 64.0) * 2.0),
        (Shape::Sphere { radius: 1.0, segments: Some(32) }, 1, f64::NAN),
        (
            Shape::Revolve { sketch: Sketch::rect(1.0, 2.0), angle: 360.0, segments: Some(64) },
            3,
            32.0 * libm::sin(2.0 * PI / 64.0) * 2.0,
        ),
    ];
    for (shape, patches, volume) in cases {
        let direct = Solid::evaluate(&shape).unwrap();
        let back = Solid::evaluate(&resample(&shape)).unwrap();
        assert!((back.volume() - direct.volume()).abs() < 1e-9, "{shape:?}");
        assert!((back.area() - direct.area()).abs() < 1e-9, "{shape:?}");
        assert_eq!(back.bbox(), direct.bbox(), "{shape:?}");
        assert_eq!(back.genus(), 0, "{shape:?}");
        assert_eq!(back.tags().len(), patches, "{shape:?} gave {:?}", back.tags());
        if volume.is_finite() {
            assert!((back.volume() - volume).abs() < 1e-9, "{shape:?}");
        }
        let c = direct.centroid();
        assert!(back.contains(c), "{shape:?}");
        let (_, hi) = direct.bbox();
        assert!(!back.contains([hi[0] + 1.0, hi[1] + 1.0, hi[2] + 1.0]), "{shape:?}");
    }
}

#[test]
fn a_torus_keeps_its_hole_and_a_bore_keeps_one_patch_per_wall() {
    let ring = Sketch::circle([1.0, 0.0], 0.25, "tube");
    let torus = Shape::Revolve { sketch: Sketch { outer: ring, holes: vec![] }, angle: 360.0, segments: Some(48) };
    let direct = Solid::evaluate(&torus).unwrap();
    assert_eq!(direct.genus(), 1);
    let back = Solid::evaluate(&resample(&torus)).unwrap();
    assert_eq!(back.genus(), 1, "an imported torus is still a torus");
    assert!((back.volume() - direct.volume()).abs() < 1e-9);

    let plate = Shape::Subtract {
        from: Box::new(Shape::Box { size: [10.0, 10.0, 2.0] }),
        cut: vec![Shape::Transform {
            shape: Box::new(Shape::Cylinder { radius: 2.0, height: 10.0, segments: Some(64) }),
            at: Affine3::translation([5.0, 5.0, -4.0]),
        }],
    };
    let s = Solid::evaluate(&resample(&plate)).unwrap();
    assert_eq!(s.genus(), 1);
    assert_eq!(s.tags().len(), 7, "{:?}", s.tags());
    // the bore wall is one smooth patch of its own; the two faces it pierces stay whole
    let areas = patch_areas(&s);
    let bore = 64.0 * 2.0 * libm::sin(PI / 64.0) * 2.0 * 2.0;
    let pierced = 100.0 - 64.0 * 0.5 * 4.0 * libm::sin(2.0 * PI / 64.0);
    assert_eq!(areas.values().filter(|a| (**a - bore).abs() < 1e-9).count(), 1, "{areas:?}");
    assert_eq!(areas.values().filter(|a| (**a - pierced).abs() < 1e-9).count(), 2, "{areas:?}");
    assert_eq!(areas.values().filter(|a| (**a - 20.0).abs() < 1e-9).count(), 4, "{areas:?}");
}

#[test]
fn the_feature_angle_chooses_how_coarse_the_patches_are() {
    let cyl = resample(&Shape::Cylinder { radius: 1.0, height: 2.0, segments: Some(8) });
    let with = |angle: f64| {
        let Shape::Mesh { positions, triangles, .. } = &cyl else { unreachable!() };
        let shape = Shape::Mesh {
            positions: positions.clone(),
            triangles: triangles.clone(),
            feature_angle: Some(angle),
            simplify_below: None,
        };
        Solid::evaluate(&shape).unwrap().tags().len()
    };
    assert_eq!(with(30.0), 8 + 2);
    assert_eq!(with(50.0), 3);
    assert_eq!(with(91.0), 1);
}

#[test]
fn simplify_below_removes_a_sliver_the_import_did_not_want() {
    let shaved = Shape::Subtract {
        from: Box::new(Shape::Box { size: [1.0; 3] }),
        cut: vec![Shape::Transform {
            shape: Box::new(Shape::Box { size: [1.0; 3] }),
            at: Affine3::translation([0.9999999, 0.9999999, 0.9999999]),
        }],
    };
    let Shape::Mesh { positions, triangles, .. } = resample(&shaved) else { unreachable!() };
    let raw = Solid::evaluate(&mesh_shape(positions.clone(), triangles.clone())).unwrap();
    let clean = Solid::evaluate(&Shape::Mesh { positions, triangles, feature_angle: None, simplify_below: Some(1e-3) })
        .unwrap();
    assert!(clean.triangles().triangles.len() < raw.triangles().triangles.len());
    assert_eq!(clean.tags().len(), 6, "back to a plain box: {:?}", clean.tags());
    assert!((clean.volume() - 1.0).abs() < 1e-6, "{}", clean.volume());
}

#[test]
fn a_lattice_meshes_an_imported_cube_and_every_face_set_resolves() {
    let (positions, triangles) = cube_soup();
    let named = Shape::Named { name: "part".into(), shape: Box::new(mesh_shape(positions, triangles)) };
    let s = Solid::evaluate(&named).unwrap();
    assert_eq!(s.tags(), ["part.face0", "part.face1", "part.face2", "part.face3", "part.face4", "part.face5"]);
    let m = lattice(&s, None, Some([4, 4, 4]), false).unwrap();
    assert_eq!(m.n_elems(), 64);
    assert!((measure(&m) - 1.0).abs() < 1e-12);
    // every boundary face of a cube lies on a bounding-box plane, so the lattice names them
    // `xmin … zmax` as it does for any body; the durable name for a patch is a predicate.
    assert_eq!(m.face_sets.len(), 6);
    for (tag, faces) in &m.face_sets {
        assert_eq!(faces.len(), 16, "{tag}");
    }
    let top = resolve_face_set(&m, &FacePredicate::Plane { normal: [0.0, 0.0, 1.0], offset: 1.0, tol: None }, None);
    assert_eq!(top.len(), 16);
}

#[test]
fn imported_meshes_are_validated_before_they_reach_the_kernel() {
    let (positions, triangles) = cube_soup();
    let err = |s: Shape| Solid::evaluate(&s).unwrap_err().0;
    assert!(err(mesh_shape(positions.clone(), triangles[..3].to_vec())).contains("at least 4 triangles"));
    assert!(err(mesh_shape(positions.clone(), vec![[0, 1, 2]; MAX_TRIANGLES + 1])).contains("limited to 500000"));
    let mut nan = positions.clone();
    nan[2][1] = f64::NAN;
    assert!(err(mesh_shape(nan, triangles.clone())).contains("vertex 2 has a non-finite coordinate"));
    let mut oob = triangles.clone();
    oob[5][2] = 99;
    assert!(err(mesh_shape(positions.clone(), oob)).contains("triangle 5 refers to vertex 99"));
    let mut flat = triangles.clone();
    flat[7] = [1, 1, 2];
    assert!(err(mesh_shape(positions.clone(), flat)).contains("triangle 7 has zero or non-finite area"));
    let huge = vec![[0.0; 3], [1e300, 0.0, 0.0], [0.0, 1e300, 0.0], [0.0, 0.0, 1.0]];
    let big = vec![[0, 1, 2], [0, 1, 3], [1, 2, 3], [0, 2, 3]];
    assert!(err(mesh_shape(huge, big)).contains("triangle 0 has zero or non-finite area"));
    let bad_angle = Shape::Mesh {
        positions: positions.clone(),
        triangles: triangles.clone(),
        feature_angle: Some(180.0),
        simplify_below: None,
    };
    assert!(err(bad_angle).contains("featureAngle must be in (0, 180)"));
    let bad_simplify = Shape::Mesh {
        positions: positions.clone(),
        triangles: triangles.clone(),
        feature_angle: None,
        simplify_below: Some(-1.0),
    };
    assert!(err(bad_simplify).contains("simplifyBelow must be zero or positive"));
    let open: Vec<[u32; 3]> = triangles.iter().copied().filter(|t| !t.contains(&6)).collect();
    assert!(err(mesh_shape(positions.clone(), open)).contains("Not Closed"));
    let gone = Shape::Mesh { positions, triangles, feature_angle: None, simplify_below: Some(100.0) };
    assert!(err(gone).contains("simplifies away to nothing"));
    let (positions, triangles) = cube_soup();
    assert!(mesh_shape(positions, triangles).contains([0.5; 3]).unwrap_err().0.contains("evaluated Solid"));
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]
    /// A random triangle soup must be rejected or evaluated, never panic the kernel: the same
    /// rule the free mesher's sketches live under (AGENTS.md, issue #5).
    #[test]
    fn a_random_triangle_soup_never_panics_the_kernel(
        coords in prop::collection::vec(-2.0f64..2.0, 12..30),
        indices in prop::collection::vec(0u32..12, 12..30),
    ) {
        let positions: Vec<[f64; 3]> = coords.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
        let triangles: Vec<[u32; 3]> = indices.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
        let shape = Shape::Mesh { positions, triangles, feature_angle: None, simplify_below: None };
        // The property is that these return at all. Any `Err` is a pass.
        if let Ok(s) = Solid::evaluate(&shape) {
            let _ = s.contains([0.1, 0.2, 0.3]);
            let _ = lattice(&s, None, Some([2, 2, 2]), false);
        }
    }
}

// ---- the free tet mesher (isosurface stuffing) ------------------------------------------------

use femlab_geometry::tet;

/// The four bodies the dihedral gate is measured on, with the **closed-form** volume of each.
///
/// The reference is the analytic volume, never `Solid::volume()`: the mesher cuts against
/// `Shape::contains`, which is an exact circle, while the Solid's own volume comes from its
/// 32-segment facets and is 0.6 % (cylinder) to 2.2 % (sphere) short of it.
fn tet_bodies() -> Vec<(&'static str, Solid, f64)> {
    vec![
        ("box", solid(Shape::Box { size: [1.0, 0.8, 0.6] }), 1.0 * 0.8 * 0.6),
        ("cylinder", solid(Shape::Cylinder { radius: 0.4, height: 1.0, segments: Some(32) }), PI * 0.16),
        ("sphere", solid(Shape::Sphere { radius: 0.5, segments: Some(32) }), 4.0 / 3.0 * PI * 0.125),
        (
            "box-minus-cylinder",
            solid(Shape::Subtract {
                from: Box::new(Shape::Box { size: [1.0, 1.0, 1.0] }),
                cut: vec![Shape::Named {
                    name: "bore".into(),
                    shape: Box::new(Shape::Transform {
                        shape: Box::new(Shape::Cylinder { radius: 0.25, height: 3.0, segments: Some(32) }),
                        at: femlab_geometry::Affine3 { translate: [0.5, 0.5, -1.0], ..Default::default() },
                    }),
                }],
            }),
            1.0 - PI * 0.0625,
        ),
    ]
}

/// A closed surface's oriented face areas cancel. A tet mesh that did not conform — a
/// quadrilateral split one way by one element and the other way by its neighbour — leaves a
/// crack whose rim shows up here, so this is the conformity check.
fn boundary_is_closed(m: &Mesh) -> f64 {
    let mut sum = [0.0; 3];
    for f in m.boundary_faces() {
        let c: Vec<[f64; 3]> = m.face_nodes(f).take(3).map(|n| m.node(n)).collect();
        let a = cross(sub(c[1], c[0]), sub(c[2], c[0]));
        for k in 0..3 {
            sum[k] += 0.5 * a[k];
        }
    }
    libm::sqrt(dot(sum, sum))
}

#[test]
fn tet_meshes_hold_their_dihedral_angles_volume_and_sets_at_two_sizes() {
    for (name, body, exact) in tet_bodies() {
        let mut previous = f64::INFINITY;
        for (size, tol) in [(0.25, 0.07), (0.125, 0.02)] {
            let m = tet(&body, size, false, 2_000_000).unwrap();
            m.validate().unwrap();
            assert_eq!(m.kind_of(0), ElementKind::Tet4, "{name}");
            assert_eq!(m.elem_sets["all"].len(), m.n_elems());
            // The isosurface-stuffing angle bound, measured rather than claimed.
            let q = quality(&m, 1);
            let lo = q.min_dihedral_deg.unwrap_or_default();
            let hi = q.max_dihedral_deg.unwrap_or_default();
            assert!(lo >= 10.7 && hi <= 164.8, "{name} at {size}: dihedral angles {lo}..{hi} degrees");
            assert!(q.min_det_j_ratio > 0.0, "{name} at {size}: an element is inverted or degenerate");
            // Conforming, so the skin closes.
            assert!(boundary_is_closed(&m) < 1e-9, "{name} at {size}: the boundary is not closed");
            // Volume against the closed form, and closer at the finer size.
            let error = (measure(&m) - exact).abs() / exact;
            assert!(error < tol, "{name} at {size}: volume error {error} against {exact}");
            assert!(error < previous, "{name} at {size}: refining did not reduce the volume error");
            previous = error;
            // Every named CSG face resolves to a non-empty face Set at both sizes.
            assert_eq!(m.face_sets.keys().cloned().collect::<Vec<_>>(), body.tags(), "{name} at {size}");
            for tag in body.tags() {
                assert!(set_len(&m, &tag) > 0, "{name} at {size}: face set '{tag}' is empty");
            }
        }
    }
}

#[test]
fn tet_meshes_are_exact_on_a_lattice_aligned_box_and_reproducible() {
    let box_ = solid(Shape::Box { size: [1.0, 1.0, 1.0] });
    let m = tet(&box_, 0.25, false, 100_000).unwrap();
    // The lattice lands on every face of an aligned box, so the twelve tetrahedra per cell
    // survive whole: 4 x 4 x 4 cells x 12, and the volume is exact.
    assert_eq!(m.n_elems(), 960);
    assert!((measure(&m) - 1.0).abs() < 1e-12, "{}", measure(&m));
    let q = quality(&m, 1);
    assert!((q.min_dihedral_deg.unwrap_or_default() - 45.0).abs() < 1e-9);
    assert!((q.max_dihedral_deg.unwrap_or_default() - 90.0).abs() < 1e-9);
    assert_eq!(m.face_sets.keys().cloned().collect::<Vec<_>>(), ["xmax", "xmin", "ymax", "ymin", "zmax", "zmin"]);
    // Nothing in the mesher reads a clock, a thread count or a hash order.
    assert_eq!(tet(&box_, 0.25, false, 100_000).unwrap(), m);
}

#[test]
fn tet10_puts_its_mid_edge_nodes_on_the_curved_face() {
    let r = 0.5;
    let ball = solid(Shape::Sphere { radius: r, segments: Some(32) });
    let m = tet(&ball, 0.2, true, 500_000).unwrap();
    m.validate().unwrap();
    assert_eq!(m.kind_of(0), ElementKind::Tet10);
    assert!(quality(&m, 1).min_det_j_ratio > 0.0);
    // On a boundary face the corners lie on the exact sphere and so, after projection, do the
    // mid-edge nodes; the straight chord midpoint would sit a sagitta inside it.
    let mut worst_node = 0.0f64;
    let mut worst_chord = 0.0f64;
    for f in m.boundary_faces() {
        let n: Vec<u32> = m.face_nodes(f).collect();
        for k in 0..3 {
            let mid = m.node(n[3 + k]);
            worst_node = worst_node.max((radius3(mid) - r).abs());
            let chord = mean(&[m.node(n[k]), m.node(n[(k + 1) % 3])]);
            worst_chord = worst_chord.max((radius3(chord) - r).abs());
        }
    }
    assert!(worst_node < 1e-9, "mid-edge node off the sphere by {worst_node}");
    assert!(worst_chord > 1e-3, "the chord midpoints were already on the sphere ({worst_chord})");
    // Interior mid-edge nodes stay at the straight midpoint.
    let e = m.elem_nodes(0);
    let straight = mean(&[m.node(e[0]), m.node(e[1])]);
    let moved = (0..3).map(|k| (m.node(e[4])[k] - straight[k]).abs()).fold(0.0f64, f64::max);
    assert!(moved < 0.2 * 0.25, "a mid-edge node moved more than a quarter of its edge");
}

fn radius3(p: [f64; 3]) -> f64 {
    libm::sqrt(dot(p, p))
}

#[test]
fn the_tet_mesher_refuses_what_it_cannot_mesh_and_says_why() {
    let ball = solid(Shape::Sphere { radius: 0.5, segments: Some(16) });
    for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert!(tet(&ball, bad, false, 100_000).unwrap_err().0.contains("positive, finite element size"));
    }
    // A denormal size is positive and finite, and is caught by the element-count estimate
    // instead of overflowing the lattice.
    assert!(tet(&ball, f64::MIN_POSITIVE / 2.0, false, 100_000).unwrap_err().0.contains("above the limit"));
    assert!(tet(&annulus_sheet(), 0.1, false, 100_000).unwrap_err().0.contains("meshes 3D solids"));
    assert!(tet(&ball, 0.01, false, 1_000).unwrap_err().0.contains("above the limit of 1000"));
    // At an element size far larger than the body no lattice vertex lands inside it.
    assert!(tet(&ball, 10.0, false, 100_000).unwrap_err().0.contains("no lattice vertex"));
    // A body one element size across is seen, but too coarsely to keep its volume.
    let bore = solid(Shape::Subtract {
        from: Box::new(Shape::Box { size: [1.0, 1.0, 0.2] }),
        cut: vec![Shape::Transform {
            shape: Box::new(Shape::Cylinder { radius: 0.45, height: 1.0, segments: Some(32) }),
            at: femlab_geometry::Affine3 { translate: [0.5, 0.5, -0.4], ..Default::default() },
        }],
    });
    assert!(tet(&bore, 0.34, false, 100_000).unwrap_err().0.contains("differs from the body's own"));
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]
    /// A mesher takes free-form geometry, so whatever the CSG tree and the element size say,
    /// the tet mesher returns. Any `Err` is a pass here; a panic is the failure.
    #[test]
    fn a_random_csg_tree_never_panics_the_tet_mesher(
        shape in any_shape(3),
        size in prop_oneof![Just(0.0), Just(-1.0), Just(f64::NAN), Just(f64::INFINITY), Just(1e-300), 0.05f64..2.0],
        quadratic in any::<bool>(),
    ) {
        // The property is that these calls return at all.
        if let Ok(s) = Solid::evaluate(&shape) {
            let _ = tet(&s, size, quadratic, 200_000);
        }
    }
}

/// Random CSG to `depth`: leaves that are degenerate as often as they are valid, transforms
/// that collapse an axis, and all three booleans over them.
fn any_shape(depth: u32) -> BoxedStrategy<Shape> {
    let leaf = prop_oneof![
        (-1.0f64..2.0, -1.0f64..2.0, -1.0f64..2.0).prop_map(|(x, y, z)| Shape::Box { size: [x, y, z] }),
        (-1.0f64..2.0, -1.0f64..2.0).prop_map(|(r, h)| Shape::Cylinder { radius: r, height: h, segments: Some(8) }),
        (-1.0f64..2.0).prop_map(|r| Shape::Sphere { radius: r, segments: Some(8) }),
        (-1.0f64..2.0).prop_map(|h| Shape::Extrude { sketch: Sketch::rect(1.0, 0.5), height: h }),
    ];
    if depth == 0 {
        return leaf.boxed();
    }
    let inner = any_shape(depth - 1);
    prop_oneof![
        leaf,
        (inner.clone(), -1.0f64..2.0).prop_map(|(s, k)| Shape::Transform {
            shape: Box::new(s),
            at: femlab_geometry::Affine3 { scale: [k, 1.0, 1.0], translate: [0.2, 0.0, 0.0], ..Default::default() },
        }),
        inner.clone().prop_map(|s| Shape::Named { name: "part".into(), shape: Box::new(s) }),
        prop::collection::vec(inner.clone(), 0..3).prop_map(|shapes| Shape::Union { shapes }),
        prop::collection::vec(inner.clone(), 0..3).prop_map(|shapes| Shape::Intersect { shapes }),
        (inner.clone(), prop::collection::vec(inner, 0..2))
            .prop_map(|(from, cut)| Shape::Subtract { from: Box::new(from), cut }),
    ]
    .boxed()
}
