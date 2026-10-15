//! Gmsh `.msh` 4.1 ASCII reader/writer (plan C §3): lets a Gmsh user open our mesh, and gives an
//! AI a textual mesh with named physical groups for our face sets and element sets.
//!
//! Node order: Gmsh's hex20 and tet10 orderings differ from Abaqus's, the order `Mesh` stores
//! (plan C §1); `tri3`, `quad4`, `tri6`, `quad8`, `line2`, `line3` need no permutation.
//! [`gmsh_permutation`] is derived from the two elements' edge lists at compile time rather than
//! hand-copied as a flat table, so it is provably the mapping its doc comment claims.
//!
//! Every node, element and face set becomes a `$PhysicalNames` entry. Element blocks are split
//! into contiguous entity blocks where necessary, so a physical group keeps an exact partial
//! block membership. A face set is written the way Gmsh represents a named boundary: as extra
//! lower-dimensional elements (Gmsh type ids `line2`=1, `tri3`=2, `quad4`=3, `line3`=8,
//! `tri6`=9, `quad8`=16). A node set becomes physical point entities with Gmsh point elements
//! (type 15). Reading maps all three representations back to the corresponding Mesh sets.

use std::collections::BTreeMap;

use femlab_geometry::{ElementBlock, ElementKind, Face, FaceKind, Mesh};

use crate::error::{Error, ErrorCode};

// ---------------------------------------------------------------- Gmsh element type ids

fn gmsh_type(kind: ElementKind) -> u32 {
    match kind {
        // Gmsh has one two-node line type; a beam written out comes back as a truss.
        ElementKind::Truss2 | ElementKind::Beam2 => 1,
        ElementKind::Tri3 => 2,
        ElementKind::Quad4 | ElementKind::Shell4 => 3,
        ElementKind::Tet4 => 4,
        ElementKind::Hex8 => 5,
        ElementKind::Tri6 => 9,
        ElementKind::Tet10 => 11,
        ElementKind::Quad8 => 16,
        ElementKind::Hex20 => 17,
    }
}

fn gmsh_face_type(kind: FaceKind) -> u32 {
    match kind {
        FaceKind::Line2 => 1,
        FaceKind::Tri3 => 2,
        FaceKind::Quad4 => 3,
        FaceKind::Line3 => 8,
        FaceKind::Tri6 => 9,
        FaceKind::Quad8 => 16,
    }
}

fn kind_of_gmsh_type(t: u32) -> Option<ElementKind> {
    Some(match t {
        1 => ElementKind::Truss2,
        2 => ElementKind::Tri3,
        3 => ElementKind::Quad4,
        4 => ElementKind::Tet4,
        5 => ElementKind::Hex8,
        9 => ElementKind::Tri6,
        11 => ElementKind::Tet10,
        16 => ElementKind::Quad8,
        17 => ElementKind::Hex20,
        _ => return None,
    })
}

fn facekind_of_gmsh_type(t: u32) -> Option<FaceKind> {
    Some(match t {
        1 => FaceKind::Line2,
        2 => FaceKind::Tri3,
        3 => FaceKind::Quad4,
        8 => FaceKind::Line3,
        9 => FaceKind::Tri6,
        16 => FaceKind::Quad8,
        _ => return None,
    })
}

fn gmsh_type_n_nodes(t: u32) -> Option<usize> {
    if t == 15 {
        Some(1)
    } else {
        kind_of_gmsh_type(t).map(ElementKind::n_nodes).or_else(|| facekind_of_gmsh_type(t).map(FaceKind::n_nodes))
    }
}

// ---------------------------------------------------------------- Abaqus -> Gmsh permutation

/// Gmsh's own mid-edge order for hex20: corners 0..7 are identical to Abaqus's; these are the
/// corner pairs of edges 8..19 in the order Gmsh lists them (plan C §1).
const GMSH_HEX20_EDGES: [[u8; 2]; 12] =
    [[0, 1], [0, 3], [0, 4], [1, 2], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 7], [5, 6], [6, 7]];

const fn identity<const N: usize>() -> [u8; N] {
    let mut a = [0u8; N];
    let mut i = 0;
    while i < N {
        a[i] = i as u8;
        i += 1;
    }
    a
}

/// The index of `pair` (in either order) in `edges`.
const fn find_edge(edges: &[[u8; 2]], pair: [u8; 2]) -> usize {
    let mut i = 0;
    while i < edges.len() {
        let e = edges[i];
        if (e[0] == pair[0] && e[1] == pair[1]) || (e[0] == pair[1] && e[1] == pair[0]) {
            return i;
        }
        i += 1;
    }
    panic!("gmsh hex20 edge not found in the Abaqus edge table")
}

/// `table[8 + g]` is the Abaqus mid-edge index (`8 + i`) whose edge is Gmsh's g-th mid-edge
/// edge, found by matching `GMSH_HEX20_EDGES[g]` against Abaqus's own edge table
/// (`ElementKind::Hex20::edges()`), never a hand-copied flat table.
const fn hex20_permutation() -> [u8; 20] {
    let mut table = identity::<20>();
    let abaqus_edges = ElementKind::Hex20.edges();
    let mut g = 0;
    while g < 12 {
        let i = find_edge(abaqus_edges, GMSH_HEX20_EDGES[g]);
        table[8 + g] = (8 + i) as u8;
        g += 1;
    }
    table
}

const fn tet10_permutation() -> [u8; 10] {
    let mut table = identity::<10>();
    table[8] = 9;
    table[9] = 8;
    table
}

const HEX8_PERM: [u8; 8] = identity();
const HEX20_PERM: [u8; 20] = hex20_permutation();
const TET4_PERM: [u8; 4] = identity();
const TET10_PERM: [u8; 10] = tet10_permutation();
const QUAD4_PERM: [u8; 4] = identity();
const QUAD8_PERM: [u8; 8] = identity();
const TRUSS2_PERM: [u8; 2] = identity();
const TRI3_PERM: [u8; 3] = identity();
const TRI6_PERM: [u8; 6] = identity();

/// Abaqus → Gmsh node permutation: `gmsh_conn[i] = abaqus_conn[table[i]]`. Identity for every
/// linear kind and for tri6/quad8 (Gmsh and Abaqus agree there); tet10 swaps its last two nodes;
/// hex20's twelve mid-edge nodes are reordered (derived above). A truss2 is Gmsh's own line
/// element in the same node order.
pub fn gmsh_permutation(kind: ElementKind) -> &'static [u8] {
    match kind {
        ElementKind::Hex8 => &HEX8_PERM,
        ElementKind::Hex20 => &HEX20_PERM,
        ElementKind::Tet4 => &TET4_PERM,
        ElementKind::Tet10 => &TET10_PERM,
        ElementKind::Quad4 | ElementKind::Shell4 => &QUAD4_PERM,
        ElementKind::Quad8 => &QUAD8_PERM,
        ElementKind::Tri3 => &TRI3_PERM,
        ElementKind::Tri6 => &TRI6_PERM,
        ElementKind::Truss2 | ElementKind::Beam2 => &TRUSS2_PERM,
    }
}

/// The inverse of a permutation table: `inv[table[i]] == i`.
fn invert(table: &[u8]) -> Vec<u8> {
    let mut inv = vec![0u8; table.len()];
    for (i, &p) in table.iter().enumerate() {
        inv[p as usize] = i as u8;
    }
    inv
}

fn group_by_face_kind(mesh: &Mesh, faces: &[Face]) -> Vec<(FaceKind, Vec<Face>)> {
    let mut groups: Vec<(FaceKind, Vec<Face>)> = Vec::new();
    for &f in faces {
        let fk = mesh.kind_of(f.elem).face_kind();
        match groups.iter_mut().find(|(k, _)| *k == fk) {
            Some((_, v)) => v.push(f),
            None => groups.push((fk, vec![f])),
        }
    }
    groups
}

// ---------------------------------------------------------------- write

struct Entity {
    dim: u8,
    tag: u32,
    phys: Vec<u32>,
    point: [f64; 3],
}

/// One Gmsh MSH 4.1 ASCII file (see the module doc for the physical-group/entity scheme).
pub fn write_msh(mesh: &Mesh) -> Result<String, Error> {
    if mesh.blocks.iter().any(|b| b.kind == ElementKind::Shell4) {
        if mesh.blocks.iter().any(|b| b.kind != ElementKind::Shell4) {
            return Err(Error::new(
                ErrorCode::Unsupported,
                "MSH export of mixed shell and volume/member blocks is not implemented",
            )
            .at("format")
            .suggest("mesh.export with format 'inp' or 'vtu'"));
        }
        // MSH quadrilaterals carry surface topology, not shell mechanics or two
        // thickness sides. Export each midsurface once, with top/bottom membership
        // as overlapping physical surface groups rather than duplicate elements.
        let mut sheet = mesh.clone();
        sheet.dim = 2;
        for block in &mut sheet.blocks {
            block.kind = ElementKind::Quad4;
        }
        for (name, faces) in &mesh.face_sets {
            let set = sheet.elem_sets.entry(name.clone()).or_default();
            set.extend(faces.iter().map(|f| f.elem));
            set.sort_unstable();
            set.dedup();
        }
        sheet.face_sets.clear();
        return Ok(write_msh_impl(&sheet));
    }
    Ok(write_msh_impl(mesh))
}

fn write_msh_impl(mesh: &Mesh) -> String {
    let (lo, hi) = mesh.bbox();
    let bbox = format!("{} {} {} {} {} {}", lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]);

    let mut phys_lines = String::new();
    let mut node_tag: BTreeMap<&str, u32> = BTreeMap::new();
    let mut face_tag: BTreeMap<&str, u32> = BTreeMap::new();
    let mut elem_tag: BTreeMap<&str, u32> = BTreeMap::new();
    let mut n_phys = 0u32;
    for name in mesh.node_sets.keys() {
        n_phys += 1;
        node_tag.insert(name.as_str(), n_phys);
        phys_lines.push_str(&format!("0 {n_phys} \"{name}\"\n"));
    }
    for name in mesh.face_sets.keys() {
        n_phys += 1;
        face_tag.insert(name.as_str(), n_phys);
        phys_lines.push_str(&format!("{} {n_phys} \"{name}\"\n", mesh.dim - 1));
    }
    for name in mesh.elem_sets.keys() {
        n_phys += 1;
        elem_tag.insert(name.as_str(), n_phys);
        phys_lines.push_str(&format!("{} {n_phys} \"{name}\"\n", mesh.dim));
    }

    struct ElementGroup {
        tag: u32,
        block: usize,
        first: usize,
        len: usize,
        phys: Vec<u32>,
    }
    let phys_of_elem = |elem: u32| -> Vec<u32> {
        mesh.elem_sets
            .iter()
            .filter(|(_, set)| set.binary_search(&elem).is_ok())
            .map(|(name, _)| elem_tag[name.as_str()])
            .collect()
    };
    let mut element_groups: Vec<ElementGroup> = Vec::new();
    for (block, blk) in mesh.blocks.iter().enumerate() {
        let mut first = 0;
        while first < blk.n_elems() {
            let phys = phys_of_elem(blk.first_elem + first as u32);
            let mut end = first + 1;
            while end < blk.n_elems() && phys_of_elem(blk.first_elem + end as u32) == phys {
                end += 1;
            }
            element_groups.push(ElementGroup {
                tag: (element_groups.len() + 1) as u32,
                block,
                first,
                len: end - first,
                phys,
            });
            first = end;
        }
    }
    struct NodeGroup {
        tag: u32,
        node: u32,
        phys: Vec<u32>,
    }
    let mut node_groups = Vec::new();
    let mut ungrouped_nodes = Vec::new();
    for node in 0..mesh.n_nodes() as u32 {
        let phys: Vec<u32> = mesh
            .node_sets
            .iter()
            .filter(|(_, set)| set.binary_search(&node).is_ok())
            .map(|(name, _)| node_tag[name.as_str()])
            .collect();
        if phys.is_empty() {
            ungrouped_nodes.push(node);
        } else {
            node_groups.push(NodeGroup { tag: (node_groups.len() + 1) as u32, node, phys });
        }
    }
    let mut entities: Vec<Entity> = node_groups
        .iter()
        .map(|g| Entity { dim: 0, tag: g.tag, phys: g.phys.clone(), point: mesh.node(g.node) })
        .collect();
    entities.extend(element_groups.iter().map(|g| Entity {
        dim: mesh.dim as u8,
        tag: g.tag,
        phys: g.phys.clone(),
        point: [0.0; 3],
    }));
    struct FaceGroup {
        tag: u32,
        phys: u32,
        kind: FaceKind,
        faces: Vec<Face>,
    }
    let mut face_groups: Vec<FaceGroup> = Vec::new();
    for (name, faces) in &mesh.face_sets {
        for (kind, group) in group_by_face_kind(mesh, faces) {
            face_groups.push(FaceGroup {
                tag: (face_groups.len() + 1) as u32,
                phys: face_tag[name.as_str()],
                kind,
                faces: group,
            });
        }
    }
    for g in &face_groups {
        entities.push(Entity { dim: mesh.dim as u8 - 1, tag: g.tag, phys: vec![g.phys], point: [0.0; 3] });
    }

    let mut s = String::new();
    s.push_str("$MeshFormat\n4.1 0 8\n$EndMeshFormat\n");
    s.push_str("$PhysicalNames\n");
    s.push_str(&format!("{n_phys}\n"));
    s.push_str(&phys_lines);
    s.push_str("$EndPhysicalNames\n");

    s.push_str("$Entities\n");
    let count_at = |d: u8| entities.iter().filter(|e| e.dim == d).count();
    s.push_str(&format!("{} {} {} {}\n", count_at(0), count_at(1), count_at(2), count_at(3)));
    for d in 0..=3u8 {
        for e in entities.iter().filter(|e| e.dim == d) {
            if d == 0 {
                s.push_str(&format!("{} {} {} {} {}", e.tag, e.point[0], e.point[1], e.point[2], e.phys.len()));
            } else {
                s.push_str(&format!("{} {bbox} {}", e.tag, e.phys.len()));
            }
            for p in &e.phys {
                s.push_str(&format!(" {p}"));
            }
            if d == 0 {
                s.push('\n');
            } else {
                s.push_str(" 0\n");
            }
        }
    }
    s.push_str("$EndEntities\n");

    s.push_str("$Nodes\n");
    let n_nodes = mesh.n_nodes();
    let n_node_blocks = node_groups.len() + usize::from(!ungrouped_nodes.is_empty());
    s.push_str(&format!("{n_node_blocks} {n_nodes} 1 {n_nodes}\n"));
    for g in &node_groups {
        s.push_str(&format!("0 {} 0 1\n{}\n", g.tag, g.node + 1));
        let c = mesh.node(g.node);
        s.push_str(&format!("{} {} {}\n", c[0], c[1], c[2]));
    }
    if !ungrouped_nodes.is_empty() {
        s.push_str(&format!("{} 1 0 {}\n", mesh.dim, ungrouped_nodes.len()));
        for &node in &ungrouped_nodes {
            s.push_str(&format!("{}\n", node + 1));
        }
        for &node in &ungrouped_nodes {
            let c = mesh.node(node);
            s.push_str(&format!("{} {} {}\n", c[0], c[1], c[2]));
        }
    }
    s.push_str("$EndNodes\n");

    s.push_str("$Elements\n");
    let n_volume = mesh.n_elems();
    let n_face: usize = face_groups.iter().map(|g| g.faces.len()).sum();
    let n_point = node_groups.len();
    let n_elements = n_volume + n_face + n_point;
    s.push_str(&format!("{} {n_elements} 1 {n_elements}\n", element_groups.len() + face_groups.len() + n_point));
    let mut tag = 1u32;
    for g in &element_groups {
        let blk = &mesh.blocks[g.block];
        let perm = gmsh_permutation(blk.kind);
        s.push_str(&format!("{} {} {} {}\n", mesh.dim, g.tag, gmsh_type(blk.kind), g.len));
        for en in blk.conn.chunks_exact(blk.kind.n_nodes()).skip(g.first).take(g.len) {
            s.push_str(&tag.to_string());
            for &p in perm {
                s.push_str(&format!(" {}", en[p as usize] + 1));
            }
            s.push('\n');
            tag += 1;
        }
    }
    for g in &face_groups {
        s.push_str(&format!("{} {} {} {}\n", mesh.dim - 1, g.tag, gmsh_face_type(g.kind), g.faces.len()));
        for &f in &g.faces {
            s.push_str(&tag.to_string());
            for n in mesh.face_nodes(f) {
                s.push_str(&format!(" {}", n + 1));
            }
            s.push('\n');
            tag += 1;
        }
    }
    for g in &node_groups {
        s.push_str(&format!("0 {} 15 1\n{tag} {}\n", g.tag, g.node + 1));
        tag += 1;
    }
    s.push_str("$EndElements\n");
    s
}

// ---------------------------------------------------------------- read

struct Lines<'a> {
    it: std::str::Lines<'a>,
    n: usize,
}

impl<'a> Lines<'a> {
    fn new(text: &'a str) -> Self {
        Lines { it: text.lines(), n: 0 }
    }
    fn next(&mut self) -> Result<(usize, &'a str), Error> {
        self.n += 1;
        match self.it.next() {
            Some(l) => Ok((self.n, l.trim())),
            None => Err(err_at(self.n, "unexpected end of file")),
        }
    }
}

fn err_at(line: usize, msg: impl Into<String>) -> Error {
    Error::new(ErrorCode::Schema, msg).at(format!("line {line}"))
}

fn expect_section(ls: &mut Lines, tag: &str) -> Result<(), Error> {
    let (line, got) = ls.next()?;
    if got != tag {
        return Err(err_at(line, format!("expected '{tag}', found '{got}'")));
    }
    Ok(())
}

fn tokens(s: &str) -> Vec<&str> {
    s.split_whitespace().collect()
}

fn parse_tok<T: std::str::FromStr>(tok: &str, line: usize) -> Result<T, Error> {
    tok.parse().map_err(|_| err_at(line, format!("expected a number, found '{tok}'")))
}

struct RawBlock {
    entity_dim: u8,
    entity_tag: u32,
    gmsh_type: u32,
    line: usize,
    elems: Vec<Vec<u32>>,
}

/// Reads the subset of Gmsh MSH 4.1 ASCII this crate writes (see the module doc): `$MeshFormat`,
/// `$PhysicalNames`, `$Entities`, `$Nodes`, and `$Elements`. The writer assigns physical tags
/// globally, and this reader likewise expects a tag to identify one name across dimensions.
/// Anything outside the supported subset — a binary file, an unknown element type or a missing
/// section — is a `Schema` error naming the line.
pub fn read_msh(text: &str) -> Result<Mesh, Error> {
    let mut ls = Lines::new(text);

    expect_section(&mut ls, "$MeshFormat")?;
    let (line, hdr) = ls.next()?;
    let t = tokens(hdr);
    if t.len() != 3 {
        return Err(err_at(line, "malformed $MeshFormat header"));
    }
    if t[0] != "4.1" {
        return Err(err_at(line, format!("only MSH 4.1 is read, found version '{}'", t[0])));
    }
    if t[1] != "0" {
        return Err(err_at(line, "binary MSH files are not supported"));
    }
    expect_section(&mut ls, "$EndMeshFormat")?;

    expect_section(&mut ls, "$PhysicalNames")?;
    let (line, n_str) = ls.next()?;
    let n_phys: usize = parse_tok(n_str, line)?;
    let mut phys_names: BTreeMap<u32, String> = BTreeMap::new();
    for _ in 0..n_phys {
        let (line, l) = ls.next()?;
        let q0 = l.find('"').ok_or_else(|| err_at(line, "malformed physical name (no quotes)"))?;
        let q1 = match l.rfind('"') {
            Some(e) if e > q0 => e,
            _ => return Err(err_at(line, "malformed physical name (no quotes)")),
        };
        let head = tokens(&l[..q0]);
        if head.len() != 2 {
            return Err(err_at(line, "malformed physical name header"));
        }
        let _dim: u8 = parse_tok(head[0], line)?;
        let tag: u32 = parse_tok(head[1], line)?;
        phys_names.insert(tag, l[q0 + 1..q1].to_string());
    }
    expect_section(&mut ls, "$EndPhysicalNames")?;

    expect_section(&mut ls, "$Entities")?;
    let (line, hdr) = ls.next()?;
    let t = tokens(hdr);
    if t.len() != 4 {
        return Err(err_at(line, "malformed $Entities header"));
    }
    let counts: Vec<usize> = t.iter().map(|s| parse_tok(s, line)).collect::<Result<_, _>>()?;
    let mut entities: BTreeMap<(u8, u32), Vec<u32>> = BTreeMap::new();
    for (d, &count) in counts.iter().enumerate() {
        for _ in 0..count {
            let (line, l) = ls.next()?;
            let tk = tokens(l);
            let n_phys_at = if d == 0 { 4 } else { 7 };
            if tk.len() <= n_phys_at {
                return Err(err_at(line, "malformed entity line"));
            }
            let tag: u32 = parse_tok(tk[0], line)?;
            let n_p: usize = parse_tok(tk[n_phys_at], line)?;
            let phys_at = n_phys_at + 1;
            let trailing = usize::from(d != 0);
            if tk.len() < phys_at + n_p + trailing {
                return Err(err_at(line, "malformed entity line"));
            }
            let phys: Vec<u32> =
                tk[phys_at..phys_at + n_p].iter().map(|s| parse_tok(s, line)).collect::<Result<_, _>>()?;
            entities.insert((d as u8, tag), phys);
        }
    }
    expect_section(&mut ls, "$EndEntities")?;

    expect_section(&mut ls, "$Nodes")?;
    let (line, hdr) = ls.next()?;
    let t = tokens(hdr);
    if t.len() != 4 {
        return Err(err_at(line, "malformed $Nodes header"));
    }
    let n_blocks: usize = parse_tok(t[0], line)?;
    let mut nodes: Vec<(u64, [f64; 3])> = Vec::new();
    for _ in 0..n_blocks {
        let (line, hdr) = ls.next()?;
        let t = tokens(hdr);
        if t.len() != 4 {
            return Err(err_at(line, "malformed node entity-block header"));
        }
        if t[2] != "0" {
            return Err(err_at(line, "parametric nodes are not supported"));
        }
        let n_in_block: usize = parse_tok(t[3], line)?;
        let mut tags = Vec::with_capacity(n_in_block);
        for _ in 0..n_in_block {
            let (line, l) = ls.next()?;
            tags.push(parse_tok(l, line)?);
        }
        for tag in tags {
            let (line, l) = ls.next()?;
            let tk = tokens(l);
            if tk.len() != 3 {
                return Err(err_at(line, "malformed node coordinates"));
            }
            nodes.push((tag, [parse_tok(tk[0], line)?, parse_tok(tk[1], line)?, parse_tok(tk[2], line)?]));
        }
    }
    expect_section(&mut ls, "$EndNodes")?;
    nodes.sort_by_key(|n| n.0);
    let tag_to_id: BTreeMap<u64, u32> = nodes.iter().enumerate().map(|(i, n)| (n.0, i as u32)).collect();
    let coords: Vec<f64> = nodes.iter().flat_map(|n| n.1).collect();

    expect_section(&mut ls, "$Elements")?;
    let (line, hdr) = ls.next()?;
    let t = tokens(hdr);
    if t.len() != 4 {
        return Err(err_at(line, "malformed $Elements header"));
    }
    let n_elem_blocks: usize = parse_tok(t[0], line)?;
    let mut raw: Vec<RawBlock> = Vec::with_capacity(n_elem_blocks);
    for _ in 0..n_elem_blocks {
        let (bline, hdr) = ls.next()?;
        let t = tokens(hdr);
        if t.len() != 4 {
            return Err(err_at(bline, "malformed element entity-block header"));
        }
        let entity_dim: u8 = parse_tok(t[0], bline)?;
        let entity_tag: u32 = parse_tok(t[1], bline)?;
        let gtype: u32 = parse_tok(t[2], bline)?;
        let n_in_block: usize = parse_tok(t[3], bline)?;
        let n_nodes_per =
            gmsh_type_n_nodes(gtype).ok_or_else(|| err_at(bline, format!("unknown gmsh element type {gtype}")))?;
        let mut elems = Vec::with_capacity(n_in_block);
        for _ in 0..n_in_block {
            let (line, l) = ls.next()?;
            let tk = tokens(l);
            if tk.len() != 1 + n_nodes_per {
                return Err(err_at(line, "malformed element line"));
            }
            let mut ids = Vec::with_capacity(n_nodes_per);
            for s in &tk[1..] {
                let ftag: u64 = parse_tok(s, line)?;
                let id = *tag_to_id
                    .get(&ftag)
                    .ok_or_else(|| err_at(line, format!("element references unknown node {ftag}")))?;
                ids.push(id);
            }
            elems.push(ids);
        }
        raw.push(RawBlock { entity_dim, entity_tag, gmsh_type: gtype, line: bline, elems });
    }
    expect_section(&mut ls, "$EndElements")?;

    let mesh_dim =
        raw.iter().map(|r| r.entity_dim).max().ok_or_else(|| err_at(line, "the mesh has no elements"))? as usize;

    let mut blocks = Vec::new();
    let mut elem_sets: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    let mut first = 0u32;
    for r in &raw {
        if r.entity_dim as usize != mesh_dim {
            continue;
        }
        let kind = kind_of_gmsh_type(r.gmsh_type)
            .ok_or_else(|| err_at(r.line, format!("unknown element type {}", r.gmsh_type)))?;
        let inv = invert(gmsh_permutation(kind));
        let mut conn = Vec::with_capacity(r.elems.len() * kind.n_nodes());
        for en in &r.elems {
            conn.extend(inv.iter().map(|&p| en[p as usize]));
        }
        let n = r.elems.len() as u32;
        for &p in entities.get(&(r.entity_dim, r.entity_tag)).into_iter().flatten() {
            let name = phys_names.get(&p).ok_or_else(|| err_at(r.line, format!("physical tag {p} is not declared")))?;
            elem_sets.entry(name.clone()).or_default().extend(first..first + n);
        }
        blocks.push(ElementBlock { kind, conn, first_elem: first });
        first += n;
    }
    for set in elem_sets.values_mut() {
        set.sort_unstable();
        set.dedup();
    }

    let mut mesh = Mesh {
        dim: mesh_dim,
        coords,
        blocks,
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::new(),
        face_sets: BTreeMap::new(),
    };

    let mut boundary_map: BTreeMap<Vec<u32>, Face> = BTreeMap::new();
    for f in mesh.boundary_faces() {
        let mut key: Vec<u32> = mesh.face_nodes(f).take(mesh.kind_of(f.elem).face_kind().n_corners()).collect();
        key.sort_unstable();
        boundary_map.insert(key, f);
    }

    let mut face_sets: BTreeMap<String, Vec<Face>> = BTreeMap::new();
    for r in &raw {
        let is_volume = r.entity_dim as usize == mesh_dim;
        let is_face = r.entity_dim as usize + 1 == mesh_dim;
        let is_point = r.entity_dim == 0 && r.gmsh_type == 15;
        if is_volume || is_point {
            continue;
        }
        if !is_face {
            return Err(err_at(r.line, format!("unsupported element dimension (entity dim {})", r.entity_dim)));
        }
        let fk = facekind_of_gmsh_type(r.gmsh_type)
            .ok_or_else(|| err_at(r.line, format!("unknown element type {}", r.gmsh_type)))?;
        let phys = entities.get(&(r.entity_dim, r.entity_tag)).cloned().unwrap_or_default();
        for en in &r.elems {
            let mut key: Vec<u32> = en[..fk.n_corners()].to_vec();
            key.sort_unstable();
            let face = *boundary_map
                .get(&key)
                .ok_or_else(|| err_at(r.line, "a face element does not match any boundary face"))?;
            for &p in &phys {
                let name =
                    phys_names.get(&p).ok_or_else(|| err_at(r.line, format!("physical tag {p} is not declared")))?;
                face_sets.entry(name.clone()).or_default().push(face);
            }
        }
    }
    for set in face_sets.values_mut() {
        set.sort_unstable();
        set.dedup();
    }

    let mut node_sets: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    for r in &raw {
        if r.entity_dim != 0 {
            continue;
        }
        let phys = entities.get(&(0, r.entity_tag)).cloned().unwrap_or_default();
        for en in &r.elems {
            for &p in &phys {
                let name =
                    phys_names.get(&p).ok_or_else(|| err_at(r.line, format!("physical tag {p} is not declared")))?;
                node_sets.entry(name.clone()).or_default().push(en[0]);
            }
        }
    }
    for (name, faces) in &face_sets {
        let mut nodes: Vec<u32> = faces.iter().flat_map(|&f| mesh.face_nodes(f)).collect();
        node_sets.entry(name.clone()).or_default().append(&mut nodes);
    }
    for set in node_sets.values_mut() {
        set.sort_unstable();
        set.dedup();
    }

    mesh.elem_sets = elem_sets;
    mesh.face_sets = face_sets;
    mesh.node_sets = node_sets;
    // A file can name a combination this reader assembles happily but the Mesh forbids — a
    // line element as the volume element of a 2D mesh, say. One check here covers every kind.
    mesh.validate().map_err(|e| Error::new(ErrorCode::Schema, e.0).at("mesh"))?;
    Ok(mesh)
}

#[cfg(test)]
mod derivation_tests {
    // `identity`, `find_edge`, `hex20_permutation` and `tet10_permutation` only ever run inside
    // a `const` initializer above (compiled away, not part of the runtime binary), so a call
    // here at plain runtime is what actually exercises the derivation this module's doc comment
    // claims — `gmsh_permutation`'s public round trip in `tests/fem.rs` only reads the already
    // baked-in tables.
    use super::{find_edge, hex20_permutation, identity, tet10_permutation, GMSH_HEX20_EDGES, HEX20_PERM, TET10_PERM};
    use femlab_geometry::ElementKind;

    #[test]
    fn the_const_derivation_matches_the_baked_in_tables() {
        assert_eq!(identity::<4>(), [0, 1, 2, 3]);
        let abaqus_edges = ElementKind::Hex20.edges();
        assert_eq!(find_edge(abaqus_edges, [7, 6]), find_edge(abaqus_edges, [6, 7]));
        assert_eq!(GMSH_HEX20_EDGES[0], [0, 1]);
        assert_eq!(hex20_permutation(), HEX20_PERM);
        assert_eq!(tet10_permutation(), TET10_PERM);
    }

    #[test]
    #[should_panic(expected = "gmsh hex20 edge not found")]
    fn find_edge_panics_when_the_pair_is_in_neither_order() {
        find_edge(ElementKind::Hex20.edges(), [0, 0]);
    }
}
