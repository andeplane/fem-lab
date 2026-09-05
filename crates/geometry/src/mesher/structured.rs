//! Structured (mapped) meshes: the image of a unit cube or square under a map, the box, the
//! annulus and the quarter elliptic annulus (NAFEMS LE1), plus the verification helpers that
//! split hexes/quads to simplices and perturb interior nodes.

use std::collections::BTreeMap;

use libm::{cos, sin};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::mesh::{ElementBlock, ElementKind, Face, Mesh};

/// Cells per direction of a mapped grid (`n[2]` is ignored for 2D kinds).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Structured {
    pub kind: ElementKind,
    pub n: [usize; 3],
}

const SET_NAMES: [&str; 6] = ["xmin", "xmax", "ymin", "ymax", "zmin", "zmax"];
/// Local face on the low / high side per axis: hex S6/S4, S3/S5, S1/S2; quad S4/S2, S1/S3.
const FACE_LOCAL_3D: [[u8; 2]; 3] = [[5, 3], [2, 4], [0, 1]];
const FACE_LOCAL_2D: [[u8; 2]; 2] = [[3, 1], [0, 2]];
/// Grid offsets of the corners in Abaqus order (the first four are the quad's).
const CORNERS: [[usize; 3]; 8] =
    [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];

/// Kuhn split of a hex into six positively oriented tets sharing the 0–6 diagonal.
const HEX_TO_TETS: [&[u8]; 6] =
    [&[0, 1, 2, 6], &[0, 5, 1, 6], &[0, 2, 3, 6], &[0, 3, 7, 6], &[0, 4, 5, 6], &[0, 7, 4, 6]];
const QUAD_TO_TRIS: [&[u8]; 2] = [&[0, 1, 2], &[0, 2, 3]];

impl Structured {
    /// Nodes at the image of the unit cube/square under `map` (2D kinds get `z = 0` parameters);
    /// face sets `xmin..zmax` (2D: `xmin..ymax`), node sets of the same names, elem set `all`.
    /// Quadratic kinds put mid-edge nodes at the image of the mid parameter, so they lie on the
    /// mapped curve, not the chord. Simplex kinds build the hex/quad grid and split it.
    pub fn build(&self, map: impl Fn([f64; 3]) -> [f64; 3]) -> Mesh {
        self.build_dyn(&map)
    }

    fn build_dyn(&self, map: &dyn Fn([f64; 3]) -> [f64; 3]) -> Mesh {
        let (grid_kind, simplex) = match self.kind {
            ElementKind::Tet4 => (ElementKind::Hex8, true),
            ElementKind::Tet10 => (ElementKind::Hex20, true),
            ElementKind::Tri3 => (ElementKind::Quad4, true),
            ElementKind::Tri6 => (ElementKind::Quad8, true),
            k => (k, false),
        };
        let dim = grid_kind.dim();
        let quadratic = grid_kind.n_nodes() > grid_kind.n_corners();
        let s = if quadratic { 2 } else { 1 };
        let cells = [self.n[0], self.n[1], if dim == 3 { self.n[2] } else { 1 }];
        // Grid points per direction (half steps for quadratic kinds); a single layer in 2D.
        let g = [s * cells[0] + 1, s * cells[1] + 1, if dim == 3 { s * cells[2] + 1 } else { 1 }];
        let gid = |p: [usize; 3]| (p[2] * g[1] + p[1]) * g[0] + p[0];

        let mut ids = vec![u32::MAX; g[0] * g[1] * g[2]];
        let mut coords = Vec::new();
        let mut node_sets: Vec<Vec<u32>> = vec![Vec::new(); 2 * dim];
        for k in 0..g[2] {
            for j in 0..g[1] {
                for i in 0..g[0] {
                    if i % s + j % s + k % s > 1 {
                        continue; // serendipity: no face-centre or body-centre nodes
                    }
                    let id = (coords.len() / 3) as u32;
                    ids[gid([i, j, k])] = id;
                    let p = [i, j, k];
                    let mut u = [0.0; 3];
                    for a in 0..dim {
                        u[a] = p[a] as f64 / (g[a] - 1) as f64;
                        if p[a] == 0 {
                            node_sets[2 * a].push(id);
                        }
                        if p[a] == g[a] - 1 {
                            node_sets[2 * a + 1].push(id);
                        }
                    }
                    coords.extend_from_slice(&map(u));
                }
            }
        }

        let n_corners = grid_kind.n_corners();
        let face_local: &[[u8; 2]] = if dim == 3 { &FACE_LOCAL_3D } else { &FACE_LOCAL_2D };
        let mut conn = Vec::new();
        let mut face_sets: Vec<Vec<Face>> = vec![Vec::new(); 2 * dim];
        let mut e = 0u32;
        for k in 0..cells[2] {
            for j in 0..cells[1] {
                for i in 0..cells[0] {
                    let cell = [i, j, k];
                    let at = |c: [usize; 3]| ids[gid([s * i + c[0], s * j + c[1], s * k + c[2]])];
                    let corner = |c: usize| [s * CORNERS[c][0], s * CORNERS[c][1], s * CORNERS[c][2]];
                    conn.extend((0..n_corners).map(|c| at(corner(c))));
                    if quadratic {
                        conn.extend(grid_kind.edges().iter().map(|&[a, b]| {
                            let (ca, cb) = (CORNERS[a as usize], CORNERS[b as usize]);
                            at([ca[0] + cb[0], ca[1] + cb[1], ca[2] + cb[2]])
                        }));
                    }
                    for a in 0..dim {
                        if cell[a] == 0 {
                            face_sets[2 * a].push(Face { elem: e, local: face_local[a][0] });
                        }
                        if cell[a] == cells[a] - 1 {
                            face_sets[2 * a + 1].push(Face { elem: e, local: face_local[a][1] });
                        }
                    }
                    e += 1;
                }
            }
        }

        let names = || SET_NAMES.iter().map(|n| n.to_string());
        let mesh = Mesh {
            dim,
            coords,
            blocks: vec![ElementBlock { kind: grid_kind, conn, first_elem: 0 }],
            node_sets: names().zip(node_sets).collect(),
            elem_sets: BTreeMap::from([("all".to_string(), (0..e).collect())]),
            face_sets: names().zip(face_sets).collect(),
        };
        if simplex {
            split_to_simplices(&mesh)
        } else {
            mesh
        }
    }

    /// An axis-aligned box from the origin to `size`.
    pub fn box_(&self, size: [f64; 3]) -> Mesh {
        self.build(|p| [p[0] * size[0], p[1] * size[1], p[2] * size[2]])
    }
}

/// hex8 → 6 tet4 (Kuhn), hex20 → tet10, quad4 → 2 tri3, quad8 → tri6; other blocks are copied.
///
/// The new mid-nodes a tet10/tri6 needs on the diagonals are evaluated with the parent's
/// serendipity shape functions (face centre: `Σ mids / 2 − Σ corners / 4`; hex body centre:
/// `Σ mids / 4 − Σ corners / 4`), so curved boundaries stay second order. Element sets and
/// face sets map to the children; a new node joins every node set that holds both nodes it
/// was interpolated between.
pub fn split_to_simplices(m: &Mesh) -> Mesh {
    let mut coords = m.coords.clone();
    let mut new_nodes: BTreeMap<(u32, u32), u32> = BTreeMap::new();
    let mut blocks = Vec::new();
    let mut children: Vec<(u32, u32)> = Vec::new(); // per parent element: (first child, count)
    let mut first = 0u32;
    for blk in &m.blocks {
        let (kind, rule): (ElementKind, &[&[u8]]) = match blk.kind {
            ElementKind::Hex8 => (ElementKind::Tet4, &HEX_TO_TETS),
            ElementKind::Hex20 => (ElementKind::Tet10, &HEX_TO_TETS),
            ElementKind::Quad4 => (ElementKind::Tri3, &QUAD_TO_TRIS),
            ElementKind::Quad8 => (ElementKind::Tri6, &QUAD_TO_TRIS),
            k => (k, &[]),
        };
        let mut conn = Vec::new();
        let block_first = first;
        for en in blk.conn.chunks_exact(blk.kind.n_nodes()) {
            if rule.is_empty() {
                conn.extend_from_slice(en);
                children.push((first, 1));
                first += 1;
                continue;
            }
            for child in rule {
                conn.extend(child.iter().map(|&c| en[c as usize]));
                if kind.n_nodes() > kind.n_corners() {
                    conn.extend(kind.edges().iter().map(|&[a, b]| {
                        mid_node(&mut coords, &mut new_nodes, blk.kind, en, child[a as usize], child[b as usize])
                    }));
                }
            }
            children.push((first, rule.len() as u32));
            first += rule.len() as u32;
        }
        blocks.push(ElementBlock { kind, conn, first_elem: block_first });
    }

    let mut out = Mesh {
        dim: m.dim,
        coords,
        blocks,
        node_sets: m.node_sets.clone(),
        elem_sets: BTreeMap::new(),
        face_sets: BTreeMap::new(),
    };
    for (name, set) in &m.elem_sets {
        let v =
            set.iter().flat_map(|&e| children[e as usize].0..children[e as usize].0 + children[e as usize].1).collect();
        out.elem_sets.insert(name.clone(), v);
    }
    for (name, set) in &m.face_sets {
        let mut v = Vec::new();
        for &f in set {
            let parent: Vec<u32> = m.face_nodes(f).take(m.kind_of(f.elem).face_kind().n_corners()).collect();
            let (c0, n) = children[f.elem as usize];
            for child in c0..c0 + n {
                let kind = out.kind_of(child);
                for local in 0..kind.n_faces() as u8 {
                    let face = Face { elem: child, local };
                    if out.face_nodes(face).take(kind.face_kind().n_corners()).all(|n| parent.contains(&n)) {
                        v.push(face);
                    }
                }
            }
        }
        v.sort_unstable();
        out.face_sets.insert(name.clone(), v);
    }
    for set in out.node_sets.values_mut() {
        let add: Vec<u32> = new_nodes
            .iter()
            .filter(|((a, b), _)| set.binary_search(a).is_ok() && set.binary_search(b).is_ok())
            .map(|(_, &id)| id)
            .collect();
        set.extend(add);
        set.sort_unstable();
    }
    out
}

/// The node at the middle of the segment between parent-local corners `a` and `b`: an existing
/// mid-edge node, or a new one on a face diagonal / the body diagonal (shared through `cache`).
fn mid_node(
    coords: &mut Vec<f64>,
    cache: &mut BTreeMap<(u32, u32), u32>,
    kind: ElementKind,
    en: &[u32],
    a: u8,
    b: u8,
) -> u32 {
    if let Some(i) = kind.edges().iter().position(|e| *e == [a, b] || *e == [b, a]) {
        return en[kind.n_corners() + i];
    }
    let key = (en[a as usize].min(en[b as usize]), en[a as usize].max(en[b as usize]));
    if let Some(&id) = cache.get(&key) {
        return id;
    }
    let fk = kind.face_kind();
    let on_face = (0..kind.n_faces())
        .map(|f| kind.face_nodes(f))
        .find(|face| face[..fk.n_corners()].contains(&a) && face[..fk.n_corners()].contains(&b));
    let (local, n_corners, w_mid): (Vec<u8>, usize, f64) = match on_face {
        Some(face) => (face.to_vec(), fk.n_corners(), 0.5),
        None => ((0..kind.n_nodes() as u8).collect(), kind.n_corners(), if kind.dim() == 3 { 0.25 } else { 0.5 }),
    };
    let mut p = [0.0; 3];
    for (i, &l) in local.iter().enumerate() {
        let w = if i < n_corners { -0.25 } else { w_mid };
        let n = en[l as usize] as usize;
        for k in 0..3 {
            p[k] += w * coords[3 * n + k];
        }
    }
    let id = (coords.len() / 3) as u32;
    coords.extend_from_slice(&p);
    cache.insert(key, id);
    id
}

/// Moves every interior node (one on no boundary face) by a uniform random offset in
/// `[-amplitude, amplitude]` per coordinate, from a deterministic LCG seeded with `seed`.
pub fn perturb_interior(m: &mut Mesh, amplitude: f64, seed: u64) {
    let mut boundary = vec![false; m.n_nodes()];
    for f in m.boundary_faces() {
        for n in m.face_nodes(f) {
            boundary[n as usize] = true;
        }
    }
    let mut state = seed;
    for (i, _) in boundary.iter().enumerate().filter(|(_, &b)| !b) {
        for k in 0..m.dim {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let u = (state >> 11) as f64 / (1u64 << 53) as f64;
            m.coords[3 * i + k] += amplitude * (2.0 * u - 1.0);
        }
    }
}

fn rename_sets(m: &mut Mesh, pairs: &[(&str, &str)]) {
    for (from, to) in pairs {
        if let Some(v) = m.node_sets.remove(*from) {
            m.node_sets.insert(to.to_string(), v);
        }
        if let Some(v) = m.face_sets.remove(*from) {
            m.face_sets.insert(to.to_string(), v);
        }
    }
}

/// A 2D annular sector in the xy plane (`kind` is a 2D kind): `n_r` cells radially between
/// `r_in` and `r_out`, `n_theta` cells from `theta[0]` to `theta[1]` (radians, increasing).
/// Sets: `inner`, `outer`, `theta0`, `theta1`.
pub fn annulus(kind: ElementKind, n_r: usize, n_theta: usize, r_in: f64, r_out: f64, theta: [f64; 2]) -> Mesh {
    let mut m = Structured { kind, n: [n_r, n_theta, 1] }.build(|p| {
        let r = r_in + p[0] * (r_out - r_in);
        let t = theta[0] + p[1] * (theta[1] - theta[0]);
        [r * cos(t), r * sin(t), 0.0]
    });
    rename_sets(&mut m, &[("xmin", "inner"), ("xmax", "outer"), ("ymin", "theta0"), ("ymax", "theta1")]);
    m
}

/// The quarter annulus in the first quadrant between the ellipses with semi-axes `inner` and
/// `outer` (NAFEMS LE1: `[2, 1]` and `[3.25, 2.75]`), `n = [radial, angular]` cells. Sets:
/// `inner`, `outer`, `y0` (on the x axis), `x0` (on the y axis). A 3D `kind` extrudes along z by
/// `depth = (height, layers)` (default one layer of unit height) and adds `bottom`, `top`.
pub fn elliptic_annulus(
    kind: ElementKind,
    n: [usize; 2],
    inner: [f64; 2],
    outer: [f64; 2],
    depth: Option<(f64, usize)>,
) -> Mesh {
    let (h, nz) = depth.unwrap_or((1.0, 1));
    let mut m = Structured { kind, n: [n[0], n[1], nz] }.build(|p| {
        let t = p[1] * std::f64::consts::FRAC_PI_2;
        let a = inner[0] + p[0] * (outer[0] - inner[0]);
        let b = inner[1] + p[0] * (outer[1] - inner[1]);
        [a * cos(t), b * sin(t), p[2] * h]
    });
    rename_sets(
        &mut m,
        &[("xmin", "inner"), ("xmax", "outer"), ("ymin", "y0"), ("ymax", "x0"), ("zmin", "bottom"), ("zmax", "top")],
    );
    m
}
