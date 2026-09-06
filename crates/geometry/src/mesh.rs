//! The Mesh shared by the meshers and the engine (plan A §2): stride-3 node coordinates,
//! contiguous element blocks in Abaqus node order, and named node / element / face sets.
//!
//! Node ordering is Abaqus's (C3D8, C3D20, C3D4, C3D10, CPS4, CPS8, CPS3, CPS6). Faces are
//! Abaqus's S1..S6 by identity, but each face lists its nodes counter-clockwise seen from
//! outside the element, so the right-hand normal of the first three corners points outward
//! (Abaqus's own listing is the reverse and points inward). In 2D the "faces" are edges,
//! ordered along the element's counter-clockwise boundary, so `(t_y, -t_x)` is outward.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::GeomError;

/// The element kinds the engine integrates: eight isoparametric solids and the two-node
/// line member (a truss), which is embedded in a 3D mesh rather than being of its dimension.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ElementKind {
    Hex8,
    Hex20,
    Tet4,
    Tet10,
    Quad4,
    Quad8,
    Tri3,
    Tri6,
    /// Two-node straight line member carrying axial force only, in a 3D mesh.
    Truss2,
}

/// The shape of an element face: a quad or triangle in 3D, a line in 2D.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum FaceKind {
    Quad4,
    Quad8,
    Tri3,
    Tri6,
    Line2,
    Line3,
}

impl FaceKind {
    pub const fn n_nodes(self) -> usize {
        match self {
            FaceKind::Quad4 => 4,
            FaceKind::Quad8 => 8,
            FaceKind::Tri3 => 3,
            FaceKind::Tri6 => 6,
            FaceKind::Line2 => 2,
            FaceKind::Line3 => 3,
        }
    }
    /// Corner nodes; the first `n_corners` entries of a face's node list.
    pub const fn n_corners(self) -> usize {
        match self {
            FaceKind::Quad4 | FaceKind::Quad8 => 4,
            FaceKind::Tri3 | FaceKind::Tri6 => 3,
            FaceKind::Line2 | FaceKind::Line3 => 2,
        }
    }
}

// Edge tables: mid-edge node `n_corners + i` of a quadratic element is the midpoint of edge `i`.
const HEX_EDGES: [[u8; 2]; 12] =
    [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const TET_EDGES: [[u8; 2]; 6] = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];
const QUAD_EDGES: [[u8; 2]; 4] = [[0, 1], [1, 2], [2, 3], [3, 0]];
const TRI_EDGES: [[u8; 2]; 3] = [[0, 1], [1, 2], [2, 0]];
const LINE_EDGES: [[u8; 2]; 1] = [[0, 1]];

// Face tables, S1..S6 (0-based), corners first then the mid-edge nodes of edges (c0c1, c1c2, ...).
const HEX8_FACES: [[u8; 4]; 6] = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
const HEX20_FACES: [[u8; 8]; 6] = [
    [0, 3, 2, 1, 11, 10, 9, 8],
    [4, 5, 6, 7, 12, 13, 14, 15],
    [0, 1, 5, 4, 8, 17, 12, 16],
    [1, 2, 6, 5, 9, 18, 13, 17],
    [2, 3, 7, 6, 10, 19, 14, 18],
    [3, 0, 4, 7, 11, 16, 15, 19],
];
const TET4_FACES: [[u8; 3]; 4] = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]];
const TET10_FACES: [[u8; 6]; 4] = [[0, 2, 1, 6, 5, 4], [0, 1, 3, 4, 8, 7], [1, 2, 3, 5, 9, 8], [2, 0, 3, 6, 7, 9]];
const QUAD4_FACES: [[u8; 2]; 4] = QUAD_EDGES;
const QUAD8_FACES: [[u8; 3]; 4] = [[0, 1, 4], [1, 2, 5], [2, 3, 6], [3, 0, 7]];
const TRI3_FACES: [[u8; 2]; 3] = TRI_EDGES;
const TRI6_FACES: [[u8; 3]; 3] = [[0, 1, 3], [1, 2, 4], [2, 0, 5]];

impl ElementKind {
    pub const fn n_nodes(self) -> usize {
        match self {
            ElementKind::Hex8 => 8,
            ElementKind::Hex20 => 20,
            ElementKind::Tet4 => 4,
            ElementKind::Tet10 => 10,
            ElementKind::Quad4 => 4,
            ElementKind::Quad8 => 8,
            ElementKind::Tri3 => 3,
            ElementKind::Tri6 => 6,
            ElementKind::Truss2 => 2,
        }
    }
    /// Corner nodes; the first `n_corners` entries of the connectivity.
    pub const fn n_corners(self) -> usize {
        match self {
            ElementKind::Hex8 | ElementKind::Hex20 => 8,
            ElementKind::Tet4 | ElementKind::Tet10 | ElementKind::Quad4 | ElementKind::Quad8 => 4,
            ElementKind::Tri3 | ElementKind::Tri6 => 3,
            ElementKind::Truss2 => 2,
        }
    }
    /// The element's own dimension: 3 for solids, 2 for plane elements, 1 for a line member.
    pub const fn dim(self) -> usize {
        match self {
            ElementKind::Hex8 | ElementKind::Hex20 | ElementKind::Tet4 | ElementKind::Tet10 => 3,
            ElementKind::Quad4 | ElementKind::Quad8 | ElementKind::Tri3 | ElementKind::Tri6 => 2,
            ElementKind::Truss2 => 1,
        }
    }
    /// Faces in 3D, edges in 2D.
    pub const fn n_faces(self) -> usize {
        match self {
            ElementKind::Hex8 | ElementKind::Hex20 => 6,
            ElementKind::Tet4 | ElementKind::Tet10 | ElementKind::Quad4 | ElementKind::Quad8 => 4,
            ElementKind::Tri3 | ElementKind::Tri6 => 3,
            ElementKind::Truss2 => 0,
        }
    }
    pub const fn face_kind(self) -> FaceKind {
        match self {
            ElementKind::Hex8 => FaceKind::Quad4,
            ElementKind::Hex20 => FaceKind::Quad8,
            ElementKind::Tet4 => FaceKind::Tri3,
            ElementKind::Tet10 => FaceKind::Tri6,
            ElementKind::Quad4 | ElementKind::Tri3 => FaceKind::Line2,
            ElementKind::Quad8 | ElementKind::Tri6 => FaceKind::Line3,
            ElementKind::Truss2 => FaceKind::Line2,
        }
    }
    /// Element-local nodes of face `f` (Abaqus S1..S6 identity), corners first, counter-clockwise
    /// seen from outside; then the mid-edge nodes of edges (c0 c1), (c1 c2), ... for quadratic kinds.
    pub const fn face_nodes(self, f: usize) -> &'static [u8] {
        match self {
            ElementKind::Hex8 => &HEX8_FACES[f],
            ElementKind::Hex20 => &HEX20_FACES[f],
            ElementKind::Tet4 => &TET4_FACES[f],
            ElementKind::Tet10 => &TET10_FACES[f],
            ElementKind::Quad4 => &QUAD4_FACES[f],
            ElementKind::Quad8 => &QUAD8_FACES[f],
            ElementKind::Tri3 => &TRI3_FACES[f],
            ElementKind::Tri6 => &TRI6_FACES[f],
            // A line member has no faces; `n_faces() == 0`, so `f` never names one.
            ElementKind::Truss2 => &[],
        }
    }
    /// Element-local corner pairs of every edge; for quadratic kinds node `n_corners() + i` is the
    /// midpoint of edge `i`.
    pub const fn edges(self) -> &'static [[u8; 2]] {
        match self {
            ElementKind::Hex8 | ElementKind::Hex20 => &HEX_EDGES,
            ElementKind::Tet4 | ElementKind::Tet10 => &TET_EDGES,
            ElementKind::Quad4 | ElementKind::Quad8 => &QUAD_EDGES,
            ElementKind::Tri3 | ElementKind::Tri6 => &TRI_EDGES,
            ElementKind::Truss2 => &LINE_EDGES,
        }
    }
}

/// One face (3D) or edge (2D) of one element.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema)]
pub struct Face {
    pub elem: u32,
    pub local: u8,
}

/// Elements of one kind, stored contiguously. FEM properties (material, formulation,
/// idealisation) live in the engine, parallel to the blocks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ElementBlock {
    pub kind: ElementKind,
    /// `n_elem * kind.n_nodes()` node ids in Abaqus order.
    pub conn: Vec<u32>,
    /// Global element id of `conn[0]`; blocks are contiguous in element id.
    pub first_elem: u32,
}

impl ElementBlock {
    pub fn n_elems(&self) -> usize {
        self.conn.len() / self.kind.n_nodes()
    }
}

/// CSR adjacency: the items of row `i` are `items[offsets[i]..offsets[i + 1]]`, ascending.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Adjacency {
    pub offsets: Vec<u32>,
    pub items: Vec<u32>,
}

impl Adjacency {
    pub fn of(&self, row: usize) -> &[u32] {
        &self.items[self.offsets[row] as usize..self.offsets[row + 1] as usize]
    }
}

/// What the viewer draws: the mesh skin as triangles plus the boundary faces and their sets.
///
/// In 3D the boundary faces are the skin: each becomes one (tri) or two (quad) triangles from
/// its corner nodes, counter-clockwise seen from outside. In 2D the sheet is its own skin, so
/// `triangles` come from the elements and the boundary faces are the `edges`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Surface {
    /// Every mesh node as `[x, y, z]`.
    pub positions: Vec<[f64; 3]>,
    /// Face-set names in `Mesh::face_sets` order.
    pub set_names: Vec<String>,
    /// `Mesh::boundary_faces()`: boundary faces (3D) or boundary edges (2D), sorted.
    pub faces: Vec<Face>,
    /// Per entry of `faces`: index into `set_names` of the first set containing it.
    pub set_of_face: Vec<Option<u32>>,
    pub triangles: Vec<[u32; 3]>,
    /// The element behind each triangle.
    pub tri_elem: Vec<u32>,
    /// 3D: per triangle the index into `faces` it was cut from. 2D: `None` for every triangle.
    pub tri_face: Vec<Option<u32>>,
    /// 2D only, parallel to `faces`: the corner nodes of each boundary edge. Empty in 3D.
    pub edges: Vec<[u32; 2]>,
}

/// Weld nodes closer together than `tol` into one, keeping the lowest node id of each cluster.
///
/// Line Bodies are meshed one at a time and concatenated, so two members that meet at a shared
/// joint arrive as two nodes at the same point; left alone they are a hinge, not a joint.
/// Clustering is by a `tol`-sized grid cell and its 26 neighbours, and a node only ever joins a
/// cluster whose survivor has a lower id, so the survivors and the renumbering are a pure
/// function of the coordinates. Element and face sets are untouched (elements keep their ids);
/// node sets are remapped and re-sorted.
pub fn merge_coincident(mesh: &mut Mesh, tol: f64) {
    let cell = |x: f64| (x / tol).floor() as i64;
    let mut buckets: BTreeMap<[i64; 3], Vec<u32>> = BTreeMap::new();
    let mut owner: Vec<u32> = Vec::with_capacity(mesh.n_nodes());
    for node in 0..mesh.n_nodes() {
        let p = mesh.node(node as u32);
        let k = [cell(p[0]), cell(p[1]), cell(p[2])];
        let mut found = None;
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    let near = buckets.get(&[k[0] + dx, k[1] + dy, k[2] + dz]);
                    for &other in near.map_or(&[][..], Vec::as_slice) {
                        let q = mesh.node(other);
                        let d2: f64 = (0..3).map(|i| (p[i] - q[i]) * (p[i] - q[i])).sum();
                        if d2 <= tol * tol && found.is_none_or(|f| other < f) {
                            found = Some(other);
                        }
                    }
                }
            }
        }
        match found {
            Some(o) => owner.push(o),
            None => {
                buckets.entry(k).or_default().push(node as u32);
                owner.push(node as u32);
            }
        }
    }
    // Survivors keep their relative order, so the renumbering is monotonic.
    let mut new_id = vec![0u32; owner.len()];
    let mut coords = Vec::with_capacity(mesh.coords.len());
    for (node, &own) in owner.iter().enumerate() {
        if own == node as u32 {
            new_id[node] = (coords.len() / 3) as u32;
            coords.extend_from_slice(&mesh.coords[3 * node..3 * node + 3]);
        }
    }
    if coords.len() == mesh.coords.len() {
        return;
    }
    mesh.coords = coords;
    for blk in &mut mesh.blocks {
        for n in &mut blk.conn {
            *n = new_id[owner[*n as usize] as usize];
        }
    }
    for set in mesh.node_sets.values_mut() {
        for n in set.iter_mut() {
            *n = new_id[owner[*n as usize] as usize];
        }
        set.sort_unstable();
        set.dedup();
    }
}

/// A finite-element mesh. Coordinates are SI metres with stride 3 (`z = 0` in 2D). Sets are
/// sorted and unique; face sets are `(element, local face)` and never node lists.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Mesh {
    /// 2 or 3.
    pub dim: usize,
    pub coords: Vec<f64>,
    pub blocks: Vec<ElementBlock>,
    pub node_sets: BTreeMap<String, Vec<u32>>,
    pub elem_sets: BTreeMap<String, Vec<u32>>,
    pub face_sets: BTreeMap<String, Vec<Face>>,
}

impl Mesh {
    pub fn n_nodes(&self) -> usize {
        self.coords.len() / 3
    }
    pub fn n_elems(&self) -> usize {
        self.blocks.iter().map(ElementBlock::n_elems).sum()
    }
    /// `(block index, element index within the block)`; `elem` must be `< n_elems()`.
    pub fn block_of(&self, elem: u32) -> (usize, usize) {
        let b = self.blocks.partition_point(|b| b.first_elem <= elem) - 1;
        (b, (elem - self.blocks[b].first_elem) as usize)
    }
    pub fn kind_of(&self, elem: u32) -> ElementKind {
        self.blocks[self.block_of(elem).0].kind
    }
    pub fn elem_nodes(&self, elem: u32) -> &[u32] {
        let (b, i) = self.block_of(elem);
        let n = self.blocks[b].kind.n_nodes();
        &self.blocks[b].conn[i * n..(i + 1) * n]
    }
    /// Gathers the element's node coordinates into `out` (`n_nodes * 3`).
    pub fn elem_coords(&self, elem: u32, out: &mut [f64]) {
        for (i, &n) in self.elem_nodes(elem).iter().enumerate() {
            out[3 * i..3 * i + 3].copy_from_slice(&self.coords[3 * n as usize..3 * n as usize + 3]);
        }
    }
    pub fn node(&self, n: u32) -> [f64; 3] {
        let c = &self.coords[3 * n as usize..3 * n as usize + 3];
        [c[0], c[1], c[2]]
    }
    /// Global node ids of a face, in the face table's order.
    pub fn face_nodes(&self, face: Face) -> impl Iterator<Item = u32> + '_ {
        let nodes = self.elem_nodes(face.elem);
        self.kind_of(face.elem).face_nodes(face.local as usize).iter().map(move |&l| nodes[l as usize])
    }
    pub fn bbox(&self) -> ([f64; 3], [f64; 3]) {
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for p in self.coords.chunks_exact(3) {
            for k in 0..3 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
        (lo, hi)
    }
    /// CSR node → incident elements, ascending.
    pub fn node_to_elems(&self) -> Adjacency {
        let mut offsets = vec![0u32; self.n_nodes() + 1];
        for e in 0..self.n_elems() as u32 {
            for &n in self.elem_nodes(e) {
                offsets[n as usize + 1] += 1;
            }
        }
        for i in 0..self.n_nodes() {
            offsets[i + 1] += offsets[i];
        }
        let mut cursor = offsets.clone();
        let mut items = vec![0u32; offsets[self.n_nodes()] as usize];
        for e in 0..self.n_elems() as u32 {
            for &n in self.elem_nodes(e) {
                items[cursor[n as usize] as usize] = e;
                cursor[n as usize] += 1;
            }
        }
        Adjacency { offsets, items }
    }
    /// Faces whose sorted node set occurs once in the mesh, sorted by `(elem, local)`.
    pub fn boundary_faces(&self) -> Vec<Face> {
        let mut keyed: Vec<(Vec<u32>, Face)> = Vec::new();
        for e in 0..self.n_elems() as u32 {
            for f in 0..self.kind_of(e).n_faces() as u8 {
                let face = Face { elem: e, local: f };
                let mut key: Vec<u32> = self.face_nodes(face).collect();
                key.sort_unstable();
                keyed.push((key, face));
            }
        }
        keyed.sort_unstable();
        let mut out: Vec<Face> = keyed.chunk_by(|a, b| a.0 == b.0).filter(|c| c.len() == 1).map(|c| c[0].1).collect();
        out.sort_unstable();
        out
    }
    /// The viewer's skin: boundary faces triangulated (3D) or the elements (2D), with the
    /// boundary faces and the first face set each belongs to. See [`Surface`].
    pub fn surface(&self) -> Surface {
        let faces = self.boundary_faces();
        let set_names: Vec<String> = self.face_sets.keys().cloned().collect();
        let mut first_set: BTreeMap<Face, u32> = BTreeMap::new();
        for (i, set) in self.face_sets.values().enumerate() {
            for &f in set {
                first_set.entry(f).or_insert(i as u32);
            }
        }
        let set_of_face = faces.iter().map(|f| first_set.get(f).copied()).collect();
        let mut s = Surface {
            positions: self.coords.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect(),
            set_names,
            faces,
            set_of_face,
            triangles: Vec::new(),
            tri_elem: Vec::new(),
            tri_face: Vec::new(),
            edges: Vec::new(),
        };
        if self.dim == 3 {
            for (i, &face) in s.faces.iter().enumerate() {
                let corners: Vec<u32> =
                    self.face_nodes(face).take(self.kind_of(face.elem).face_kind().n_corners()).collect();
                for t in 1..corners.len() - 1 {
                    s.triangles.push([corners[0], corners[t], corners[t + 1]]);
                    s.tri_elem.push(face.elem);
                    s.tri_face.push(Some(i as u32));
                }
            }
        } else {
            for &face in &s.faces {
                let c: Vec<u32> = self.face_nodes(face).take(2).collect();
                s.edges.push([c[0], c[1]]);
            }
            for e in 0..self.n_elems() as u32 {
                let corners = &self.elem_nodes(e)[..self.kind_of(e).n_corners()];
                for t in 1..corners.len() - 1 {
                    s.triangles.push([corners[0], corners[t], corners[t + 1]]);
                    s.tri_elem.push(e);
                    s.tri_face.push(None);
                }
            }
        }
        s
    }
    /// Indices in range, sets sorted and unique, blocks contiguous and of the mesh's dimension,
    /// connectivity lengths multiples of the node count.
    pub fn validate(&self) -> Result<(), GeomError> {
        if !self.coords.len().is_multiple_of(3) {
            return Err(GeomError(format!("coords length {} is not a multiple of 3", self.coords.len())));
        }
        if self.dim != 2 && self.dim != 3 {
            return Err(GeomError(format!("dim must be 2 or 3, got {}", self.dim)));
        }
        let n_nodes = self.n_nodes() as u32;
        let mut next = 0u32;
        for (b, blk) in self.blocks.iter().enumerate() {
            // A line member is embedded in the mesh's space rather than being of its
            // dimension: its two nodes carry the mesh's three displacements, so it belongs in
            // a 3D mesh whatever direction it points.
            if blk.kind.dim() != self.dim && !(blk.kind.dim() == 1 && self.dim == 3) {
                return Err(GeomError(format!("block {b} is {:?} in a {}D mesh", blk.kind, self.dim)));
            }
            if !blk.conn.len().is_multiple_of(blk.kind.n_nodes()) {
                return Err(GeomError(format!(
                    "block {b}: conn length {} is not a multiple of {}",
                    blk.conn.len(),
                    blk.kind.n_nodes()
                )));
            }
            if blk.first_elem != next {
                return Err(GeomError(format!(
                    "block {b}: first_elem {} but the previous block ends at {next}",
                    blk.first_elem
                )));
            }
            if let Some(bad) = blk.conn.iter().find(|&&n| n >= n_nodes) {
                return Err(GeomError(format!("block {b} references node {bad} but the mesh has {n_nodes} nodes")));
            }
            next += blk.n_elems() as u32;
        }
        let n_elems = next;
        for (name, set) in &self.node_sets {
            if !set.is_sorted_by(|a, b| a < b) {
                return Err(GeomError(format!("node set '{name}' is not sorted and unique")));
            }
            if let Some(bad) = set.iter().find(|&&n| n >= n_nodes) {
                return Err(GeomError(format!(
                    "node set '{name}' references node {bad} but the mesh has {n_nodes} nodes"
                )));
            }
        }
        for (name, set) in &self.elem_sets {
            if !set.is_sorted_by(|a, b| a < b) {
                return Err(GeomError(format!("element set '{name}' is not sorted and unique")));
            }
            if let Some(bad) = set.iter().find(|&&e| e >= n_elems) {
                return Err(GeomError(format!(
                    "element set '{name}' references element {bad} but the mesh has {n_elems} elements"
                )));
            }
        }
        for (name, set) in &self.face_sets {
            if !set.is_sorted_by(|a, b| a < b) {
                return Err(GeomError(format!("face set '{name}' is not sorted and unique")));
            }
            for f in set {
                if f.elem >= n_elems {
                    return Err(GeomError(format!(
                        "face set '{name}' references element {} but the mesh has {n_elems} elements",
                        f.elem
                    )));
                }
                if f.local as usize >= self.kind_of(f.elem).n_faces() {
                    return Err(GeomError(format!("face set '{name}': element {} has no face {}", f.elem, f.local)));
                }
            }
        }
        Ok(())
    }
}
