//! Structured MITC4 midsurfaces: bilinear 3D patches, optionally projected onto a
//! cylinder or sphere. Analytic mapping derivatives supply the corner directors;
//! facets therefore do not replace a smooth shell's nodal normal field.

use crate::{merge_coincident, ElementBlock, ElementKind, Face, GeomError, Mesh};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

type V = [f64; 3];

/// Optional radial projection of a bilinear patch, all coordinates in SI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Projection {
    Sphere { center: V, radius: f64 },
    Cylinder { center: V, axis: V, radius: f64 },
}

/// One oriented quadrilateral patch. Corners run counter-clockwise when seen from
/// its positive side. Tags name node Sets on edges 0–1, 1–2, 2–3 and 3–0.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SurfacePatch {
    pub corners: [V; 4],
    pub n: [usize; 2],
    pub tags: [Option<String>; 4],
    pub projection: Option<Projection>,
}

/// A shell mesh plus its four directors per element, in element order. Separate
/// patches share global unknowns at coincident nodes but retain distinct directors
/// at a crease. Smooth projected patches agree on their common edge directors.
pub struct SurfaceMesh {
    pub mesh: Mesh,
    pub directors: Vec<[V; 4]>,
}

fn dot(a: V, b: V) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V, b: V) -> V {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn subtract(a: V, b: V) -> V {
    std::array::from_fn(|k| a[k] - b[k])
}
fn normal(v: V) -> Result<V, GeomError> {
    let norm = libm::sqrt(dot(v, v));
    if !norm.is_finite() || norm <= 0.0 {
        return Err(GeomError("surface mapping is singular or non-finite".into()));
    }
    Ok(v.map(|x| x / norm))
}

impl SurfacePatch {
    fn sample(&self, u: f64, v: f64) -> Result<(V, V), GeomError> {
        let n = [(1.0 - u) * (1.0 - v), u * (1.0 - v), u * v, (1.0 - u) * v];
        let nu = [v - 1.0, 1.0 - v, v, -v];
        let nv = [u - 1.0, -u, u, 1.0 - u];
        let mut x: V = std::array::from_fn(|k| (0..4).map(|i| n[i] * self.corners[i][k]).sum());
        let mut du: V =
            std::array::from_fn(|k| (0..4).map(|i| nu[i] * (self.corners[i][k] - self.corners[0][k])).sum());
        let mut dv: V =
            std::array::from_fn(|k| (0..4).map(|i| nv[i] * (self.corners[i][k] - self.corners[0][k])).sum());
        if let Some(projection) = &self.projection {
            let (center, radius, axis) = match *projection {
                Projection::Sphere { center, radius } => (center, radius, [0.0; 3]),
                Projection::Cylinder { center, radius, axis } => (center, radius, normal(axis)?),
            };
            if !radius.is_finite() || radius <= 0.0 {
                return Err(GeomError("projection radius must be positive and finite".into()));
            }
            let q = subtract(x, center);
            let along = dot(q, axis);
            let radial = subtract(q, axis.map(|a| a * along));
            let nr = normal(radial)?;
            let factor = radius / libm::sqrt(dot(radial, radial));
            x = std::array::from_fn(|k| center[k] + along * axis[k] + radius * nr[k]);
            for tangent in [&mut du, &mut dv] {
                let axial = dot(*tangent, axis);
                let radial = dot(*tangent, nr);
                *tangent =
                    std::array::from_fn(|k| axial * axis[k] + factor * (tangent[k] - axial * axis[k] - radial * nr[k]));
            }
        }
        if !x.into_iter().all(f64::is_finite) {
            return Err(GeomError("surface coordinates are non-finite".into()));
        }
        let crossed = cross(du, dv);
        let scale = dot(du, du) * dot(dv, dv);
        if dot(crossed, crossed) <= 1e-24 * scale {
            return Err(GeomError("surface patch is folded or degenerate".into()));
        }
        Ok((x, normal(crossed)?))
    }
}

/// Mesh conforming patches with a shared node on each common vertex. A mismatch
/// on a shared edge is an error, never a disconnected shell hidden by rendering.
/// The 500,000 element limit is checked before allocation.
pub fn surface(patches: &[SurfacePatch]) -> Result<SurfaceMesh, GeomError> {
    let mut count = 0usize;
    if patches.is_empty() || patches.len() > 1024 {
        return Err(GeomError("a surface mesh needs between 1 and 1024 patches".into()));
    }
    for p in patches {
        let size =
            p.n[0].checked_mul(p.n[1]).ok_or_else(|| GeomError("surface mesh exceeds 500000 elements".into()))?;
        count = count.saturating_add(size);
        if p.n.contains(&0) || count > 500_000 {
            return Err(GeomError("surface divisions must be positive and total at most 500000 elements".into()));
        }
        if p.tags.iter().flatten().any(|t| t.is_empty() || t == "top" || t == "bottom") {
            return Err(GeomError("edge tags must be nonempty and distinct from top and bottom".into()));
        }
    }
    let mut mesh = Mesh {
        dim: 3,
        coords: vec![],
        blocks: vec![],
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::new(),
        face_sets: BTreeMap::new(),
    };
    let mut connectivity = Vec::with_capacity(4 * count);
    let mut directors = Vec::with_capacity(count);
    // Temporary edge Sets survive coordinate merging, allowing conformity checks on ids.
    let mut edge_sets = Vec::new();
    for (patch_id, p) in patches.iter().enumerate() {
        let (_, centre) = p.sample(0.5, 0.5)?;
        let offset = mesh.n_nodes() as u32;
        let id = |i: usize, j: usize| offset + (j * (p.n[0] + 1) + i) as u32;
        let mut normals = Vec::with_capacity((p.n[0] + 1) * (p.n[1] + 1));
        for j in 0..=p.n[1] {
            for i in 0..=p.n[0] {
                let (x, d) = p.sample(i as f64 / p.n[0] as f64, j as f64 / p.n[1] as f64)?;
                if dot(d, centre) <= 1e-10 {
                    return Err(GeomError(
                        "surface patch folds or spans more than a hemisphere; split it into patches".into(),
                    ));
                }
                mesh.coords.extend(x);
                normals.push(d);
            }
        }
        for j in 0..p.n[1] {
            for i in 0..p.n[0] {
                let c = [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)];
                connectivity.extend(c);
                directors.push(c.map(|n| normals[(n - offset) as usize]));
            }
        }
        let edges = [
            (0..=p.n[0]).map(|i| id(i, 0)).collect::<Vec<_>>(),
            (0..=p.n[1]).map(|j| id(p.n[0], j)).collect(),
            (0..=p.n[0]).map(|i| id(i, p.n[1])).collect(),
            (0..=p.n[1]).map(|j| id(0, j)).collect(),
        ];
        for (edge, nodes) in edges.into_iter().enumerate() {
            let key = format!("__surface_{patch_id}_{edge}");
            mesh.node_sets.insert(key.clone(), nodes);
            edge_sets.push((key, p.tags[edge].clone()));
        }
    }
    mesh.blocks.push(ElementBlock { kind: ElementKind::Shell4, conn: connectivity, first_elem: 0 });
    let (lo, hi) = mesh.bbox();
    let delta = subtract(hi, lo);
    let tolerance = 1e-10 * libm::sqrt(dot(delta, delta));
    if !tolerance.is_finite() || tolerance <= 0.0 {
        return Err(GeomError("surface extent is not representable".into()));
    }
    // Keep edge endpoints separately: merge_coincident sorts node Sets by node id.
    let endpoints: Vec<_> = edge_sets
        .iter()
        .map(|(key, _)| {
            let edge = &mesh.node_sets[key];
            [mesh.node(edge[0]), mesh.node(edge[edge.len() - 1])]
        })
        .collect();
    merge_coincident(&mut mesh, tolerance);
    let mut unique = BTreeSet::new();
    for conn in mesh.blocks[0].conn.chunks_exact(4) {
        let mut nodes = [conn[0], conn[1], conn[2], conn[3]];
        nodes.sort_unstable();
        if nodes.windows(2).any(|pair| pair[0] == pair[1]) || !unique.insert(nodes) {
            return Err(GeomError("surface elements collapse or overlap after node merging".into()));
        }
    }
    for a in 0..edge_sets.len() {
        for b in a + 1..edge_sets.len() {
            let distance = |x: V, y: V| {
                let d = subtract(x, y);
                dot(d, d)
            };
            let same = (distance(endpoints[a][0], endpoints[b][0]) < tolerance * tolerance
                && distance(endpoints[a][1], endpoints[b][1]) < tolerance * tolerance)
                || (distance(endpoints[a][0], endpoints[b][1]) < tolerance * tolerance
                    && distance(endpoints[a][1], endpoints[b][0]) < tolerance * tolerance);
            let ea = &mesh.node_sets[&edge_sets[a].0];
            let eb = &mesh.node_sets[&edge_sets[b].0];
            let shared: Vec<_> = ea.iter().filter(|n| eb.binary_search(n).is_ok()).collect();
            let interior_joint = shared.iter().any(|&&n| {
                let point = mesh.node(n);
                [a, b]
                    .into_iter()
                    .any(|edge| endpoints[edge].iter().all(|&end| distance(point, end) > tolerance * tolerance))
            });
            if (same || shared.len() > 1 || interior_joint) && ea != eb {
                return Err(GeomError("surface patches have different divisions on a shared edge".into()));
            }
        }
    }
    let mut tags: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    for (key, tag) in edge_sets {
        let nodes = mesh.node_sets.remove(&key).expect("each temporary edge Set is inserted once");
        if let Some(tag) = tag {
            tags.entry(tag).or_default().extend(nodes);
        }
    }
    for nodes in tags.values_mut() {
        nodes.sort_unstable();
        nodes.dedup();
    }
    mesh.node_sets = tags;
    for (name, local) in [("bottom", 0), ("top", 1)] {
        mesh.face_sets.insert(name.into(), (0..count as u32).map(|elem| Face { elem, local }).collect());
    }
    mesh.elem_sets.insert("all".into(), (0..count as u32).collect());
    Ok(SurfaceMesh { mesh, directors })
}
