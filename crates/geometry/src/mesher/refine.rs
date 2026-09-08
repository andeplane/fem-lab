//! Conforming local refinement of linear simplices by edge bisection. Every element
//! incident on a selected edge is split together, so no hanging nodes are introduced.
//! The input mesher still owns the boundary approximation: new points lie on its edges.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{ElementKind, Face, GeomError, Mesh};

/// A local maximum edge length in an axis-aligned world-coordinate box, SI.
/// Elements whose bounding boxes intersect this box obey its size. Overlapping
/// boxes use the smallest size; closure may also split adjacent elements.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SizeBox {
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub size: f64,
}

impl SizeBox {
    pub fn check(&self) -> Result<(), GeomError> {
        if !self.size.is_finite()
            || self.size <= 0.0
            || (0..3).any(|a| !self.min[a].is_finite() || !self.max[a].is_finite() || self.min[a] > self.max[a])
        {
            return Err(GeomError("a refinement box needs finite ordered bounds and a positive finite size".into()));
        }
        Ok(())
    }

    fn intersects(&self, lo: &[f64; 3], hi: &[f64; 3]) -> bool {
        (0..3).all(|a| lo[a] <= self.max[a] && hi[a] >= self.min[a])
    }
}

/// Refine into a new mesh, preserving element blocks, element Sets, face tags and node
/// Sets. Refuses before a split would exceed `max_elements`. Iteration and tie breaking
/// use sorted node ids, so repeated calls on the same input are identical.
pub fn refine(mesh: &Mesh, boxes: &[SizeBox], max_elements: usize) -> Result<Mesh, GeomError> {
    for region in boxes {
        region.check()?;
    }
    if !boxes.is_empty() && mesh.blocks.iter().any(|b| b.kind != ElementKind::Tri3 && b.kind != ElementKind::Tet4) {
        return Err(GeomError("local refinement requires linear tri3 or tet4 elements".into()));
    }
    if mesh.n_elems() > max_elements {
        return Err(GeomError(format!("mesh has {} elements, above refinement limit {max_elements}", mesh.n_elems())));
    }
    let mut out = mesh.clone();
    loop {
        let mut edges = BTreeSet::new();
        for e in 0..out.n_elems() as u32 {
            let nodes = out.elem_nodes(e);
            let mut lo = [f64::INFINITY; 3];
            let mut hi = [f64::NEG_INFINITY; 3];
            for &node in nodes {
                let x = out.node(node);
                for a in 0..3 {
                    lo[a] = lo[a].min(x[a]);
                    hi[a] = hi[a].max(x[a]);
                }
            }
            let size = boxes.iter().filter(|b| b.intersects(&lo, &hi)).map(|b| b.size).fold(f64::INFINITY, f64::min);
            let mut longest = 0.0;
            let mut edge = [0; 2];
            for &[a, b] in out.kind_of(e).edges() {
                let mut pair = [nodes[a as usize], nodes[b as usize]];
                pair.sort();
                let x = out.node(pair[0]);
                let y = out.node(pair[1]);
                let length = libm::hypot(libm::hypot(x[0] - y[0], x[1] - y[1]), x[2] - y[2]);
                if length > longest || (length == longest && pair < edge) {
                    longest = length;
                    edge = pair;
                }
            }
            if longest > size * (1.0 + 1e-12) {
                edges.insert(edge);
            }
        }
        if edges.is_empty() {
            return Ok(out);
        }
        bisect(&mut out, &edges, max_elements)?;
    }
}

fn bisect(mesh: &mut Mesh, edges: &BTreeSet<[u32; 2]>, max_elements: usize) -> Result<(), GeomError> {
    if mesh.n_elems() + edges.len() > max_elements {
        return Err(GeomError(format!("local refinement would exceed {max_elements} elements")));
    }
    let mut mids = BTreeMap::new();
    for &edge in edges {
        let mid = mesh.n_nodes() as u32;
        let x = mesh.node(edge[0]);
        let y = mesh.node(edge[1]);
        let point = std::array::from_fn::<_, 3, _>(|a| x[a] * 0.5 + y[a] * 0.5);
        if point == x || point == y {
            return Err(GeomError("refinement reached floating-point coordinate resolution".into()));
        }
        mesh.coords.extend_from_slice(&point);
        mids.insert(edge, mid);
    }
    let old = mesh.blocks.clone();
    let mut children = vec![Vec::new(); mesh.n_elems()];
    let mut next = 0u32;
    for (block, previous) in mesh.blocks.iter_mut().zip(&old) {
        block.first_elem = next;
        block.conn.clear();
        for (i, nodes) in previous.conn.chunks_exact(previous.kind.n_nodes()).enumerate() {
            let list = &mut children[previous.first_elem as usize + i];
            let mut local_edges = Vec::new();
            for &[a, b] in previous.kind.edges() {
                let mut pair = [nodes[a as usize], nodes[b as usize]];
                pair.sort();
                if let Some(&mid) = mids.get(&pair) {
                    local_edges.push((pair, mid));
                }
            }
            local_edges.sort_unstable();
            let mut parts = vec![nodes.to_vec()];
            for (edge, mid) in local_edges {
                let mut split = Vec::new();
                for part in parts {
                    if part.contains(&edge[0]) && part.contains(&edge[1]) {
                        // Replacing either endpoint in-place preserves orientation.
                        for endpoint in edge {
                            split.push(part.iter().map(|&n| if n == endpoint { mid } else { n }).collect());
                        }
                    } else {
                        split.push(part);
                    }
                }
                parts = split;
            }
            if next as usize + parts.len() > max_elements {
                return Err(GeomError(format!("local refinement would exceed {max_elements} elements")));
            }
            for part in parts {
                block.conn.extend(part);
                list.push(next);
                next += 1;
            }
        }
    }
    for set in mesh.elem_sets.values_mut() {
        *set = set.iter().flat_map(|&e| children[e as usize].iter().copied()).collect();
        set.sort_unstable();
        set.dedup();
    }
    let old_faces = std::mem::take(&mut mesh.face_sets);
    for (name, faces) in old_faces {
        let mut mapped = Vec::new();
        for face in faces {
            let bi = old.partition_point(|b| b.first_elem <= face.elem) - 1;
            let block = &old[bi];
            let nn = block.kind.n_nodes();
            let offset = (face.elem - block.first_elem) as usize * nn;
            let mut allowed: Vec<_> =
                block.kind.face_nodes(face.local as usize).iter().map(|&a| block.conn[offset + a as usize]).collect();
            let corners = allowed.clone();
            for (i, &a) in corners.iter().enumerate() {
                for &b in &corners[i + 1..] {
                    let mut pair = [a, b];
                    pair.sort();
                    if let Some(&mid) = mids.get(&pair) {
                        allowed.push(mid);
                    }
                }
            }
            for &elem in &children[face.elem as usize] {
                for local in 0..block.kind.n_faces() as u8 {
                    let child = Face { elem, local };
                    if mesh.face_nodes(child).all(|n| allowed.contains(&n)) {
                        mapped.push(child);
                    }
                }
            }
        }
        mapped.sort_unstable();
        mapped.dedup();
        mesh.face_sets.insert(name, mapped);
    }
    for set in mesh.node_sets.values_mut() {
        let old: BTreeSet<_> = set.iter().copied().collect();
        for (&[a, b], &mid) in &mids {
            if old.contains(&a) && old.contains(&b) {
                set.push(mid);
            }
        }
        set.sort_unstable();
        set.dedup();
    }
    Ok(())
}
