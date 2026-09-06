//! Free 2D triangle meshing of a [`Sketch`] with `weka`, a pure-Rust port of Shewchuk's
//! Triangle (C §2.7 "Free 2D").
//!
//! The sketch's loops are sampled into a PSLG: the outer loop bounds the domain, each hole loop
//! is carved by a seed point inside it, and every segment carries a marker that is the id of
//! its tag. Markers propagate to the segments that refinement splits, so every boundary edge of
//! the result names the sketch segment it came from and becomes a face set of that tag. Quality
//! is Ruppert refinement to a 30° minimum angle and `max_area = size²/2`, the area of a
//! right-isoceles triangle with legs `size`.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use weka::{InputMesh, Pslg, Triangulator};

use crate::mesh::{ElementBlock, ElementKind, Face, Mesh};
use crate::sketch::Sketch;
use crate::GeomError;

/// A local element size inside an axis-aligned box, for the free mesher's `refine` pass.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RefineBox {
    pub min: [f64; 2],
    pub max: [f64; 2],
    pub size: f64,
}

impl RefineBox {
    fn contains(&self, p: [f64; 2]) -> bool {
        (0..2).all(|a| p[a] >= self.min[a] && p[a] <= self.max[a])
    }
}

/// Arcs are sampled this finely relative to the element size, so a finer mesh gets a rounder
/// hole and the chord error stays well below the discretisation error.
const CHORD_FRACTION: f64 = 0.1;

/// The largest triangle of an element size: a right-isoceles triangle with legs `size`.
fn max_area(size: f64) -> f64 {
    0.5 * size * size
}

/// Mesh the interior of `sketch` with triangles of about `size`, tri6 when `quadratic`.
///
/// Every sketch segment's tag becomes a face set holding the boundary edges that lie on it.
/// The element set `all` holds every element. Each [`RefineBox`] imposes its own smaller size
/// on the triangles whose centroid is inside it, through a second `weka` refinement pass with
/// per-triangle area constraints (`weka` 0.1 has no size callback).
pub fn free(sketch: &Sketch, size: f64, quadratic: bool, refine: &[RefineBox]) -> Result<Mesh, GeomError> {
    if !(size.is_finite() && size > 0.0) {
        return Err(GeomError(format!("the element size is {size}; it must be finite and positive")));
    }
    for (i, b) in refine.iter().enumerate() {
        if !(b.size.is_finite() && b.size > 0.0) {
            return Err(GeomError(format!("refine box {i} has size {}; it must be finite and positive", b.size)));
        }
    }
    // weka panics on crossing or degenerate input segments, so no sketch reaches it unchecked.
    sketch.check()?;
    let loops = sketch.loops(CHORD_FRACTION * size)?;
    let mut lo = [f64::INFINITY; 2];
    let mut hi = [f64::NEG_INFINITY; 2];
    for p in &loops[0].pts {
        for a in 0..2 {
            lo[a] = lo[a].min(p[a]);
            hi[a] = hi[a].max(p[a]);
        }
    }
    let eps = 1e-6 * libm::hypot(hi[0] - lo[0], hi[1] - lo[1]);

    let mut tag_ids: BTreeMap<String, i32> = BTreeMap::new();
    let mut pslg = Pslg::default();
    let mut markers = Vec::new();
    for (i, l) in loops.iter().enumerate() {
        let first = pslg.points.len();
        pslg.points.extend_from_slice(&l.pts);
        let n = l.pts.len();
        for j in 0..n {
            pslg.segments.push([first + j, first + (j + 1) % n]);
            let next = tag_ids.len() as i32 + 1;
            markers.push(*tag_ids.entry(l.tags[j].clone()).or_insert(next));
        }
        if i > 0 {
            // A hole seed: the loop's centroid, or a point pushed just inside the first edge
            // when the centroid falls outside a concave hole. Hole loops run clockwise, so the
            // hole's interior is to the right of an edge.
            let c = [
                l.pts.iter().map(|p| p[0]).sum::<f64>() / n as f64,
                l.pts.iter().map(|p| p[1]).sum::<f64>() / n as f64,
            ];
            pslg.holes.push(if l.contains(c) {
                c
            } else {
                let d = [l.pts[1][0] - l.pts[0][0], l.pts[1][1] - l.pts[0][1]];
                let len = libm::hypot(d[0], d[1]);
                [
                    0.5 * (l.pts[0][0] + l.pts[1][0]) + eps * d[1] / len,
                    0.5 * (l.pts[0][1] + l.pts[1][1]) - eps * d[0] / len,
                ]
            });
        }
    }
    pslg.segment_markers = Some(markers);

    let base = Triangulator::new().min_angle(30.0).max_area(max_area(size));
    let tri = if refine.is_empty() {
        base.quadratic(quadratic).triangulate_pslg(&pslg)
    } else {
        base.triangulate_pslg(&pslg).and_then(|coarse| {
            let areas = coarse
                .triangles
                .iter()
                .map(|t| {
                    let c = [
                        (coarse.points[t[0]][0] + coarse.points[t[1]][0] + coarse.points[t[2]][0]) / 3.0,
                        (coarse.points[t[0]][1] + coarse.points[t[1]][1] + coarse.points[t[2]][1]) / 3.0,
                    ];
                    // 0 means "no local bound"; the global max_area still applies everywhere.
                    refine.iter().filter(|b| b.contains(c)).map(|b| max_area(b.size)).fold(0.0, f64::max)
                })
                .collect();
            let input = InputMesh {
                points: coarse.points,
                triangles: coarse.triangles,
                triangle_area_constraints: Some(areas),
                segments: coarse.segments,
                segment_markers: Some(coarse.segment_markers),
                ..Default::default()
            };
            base.quadratic(quadratic).refine(&input)
        })
    }
    .map_err(|e| GeomError(e.to_string()))?;
    if tri.triangles.is_empty() {
        return Err(GeomError(
            "the free mesher produced no triangle; every hole loop must lie strictly inside the outer loop".into(),
        ));
    }

    let kind = if quadratic { ElementKind::Tri6 } else { ElementKind::Tri3 };
    let mut coords = Vec::with_capacity(3 * tri.points.len());
    for p in &tri.points {
        coords.extend_from_slice(&[p[0], p[1], 0.0]);
    }
    let mut conn = Vec::with_capacity(tri.triangles.len() * kind.n_nodes());
    for (t, c) in tri.triangles.iter().enumerate() {
        conn.extend(c.iter().map(|&n| n as u32));
        if let Some(e) = tri.edge_nodes.as_ref() {
            // weka's edge_nodes[k] is the midpoint of the edge opposite corner k; Abaqus wants
            // the midpoints of (0,1), (1,2), (2,0), which are e2, e0, e1.
            conn.extend([e[t][2], e[t][0], e[t][1]].iter().map(|&n| n as u32));
        }
    }

    // Marker `i` names `names[i]`; marker 0 is a boundary edge weka did not inherit a marker
    // for, which a PSLG that covers its own hull never produces.
    let mut names: Vec<&str> = vec!["boundary"];
    let mut by_id: Vec<(i32, &str)> = tag_ids.iter().map(|(n, &i)| (i, n.as_str())).collect();
    by_id.sort_unstable();
    names.extend(by_id.into_iter().map(|(_, n)| n));
    let mut on_boundary: BTreeMap<[u32; 2], &str> = BTreeMap::new();
    for (s, &m) in tri.segments.iter().zip(&tri.segment_markers) {
        let (a, b) = (s[0] as u32, s[1] as u32);
        on_boundary.insert([a.min(b), a.max(b)], names.get(m as usize).copied().unwrap_or("boundary"));
    }
    let mut mesh = Mesh {
        dim: 2,
        coords,
        blocks: vec![ElementBlock { kind, conn, first_elem: 0 }],
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::from([("all".to_string(), (0..tri.triangles.len() as u32).collect())]),
        face_sets: BTreeMap::new(),
    };
    let mut face_sets: BTreeMap<String, Vec<Face>> = BTreeMap::new();
    for e in 0..mesh.n_elems() as u32 {
        let nodes = mesh.elem_nodes(e).to_vec();
        for (local, edge) in kind.edges().iter().enumerate() {
            let (a, b) = (nodes[edge[0] as usize], nodes[edge[1] as usize]);
            if let Some(&name) = on_boundary.get(&[a.min(b), a.max(b)]) {
                face_sets.entry(name.to_string()).or_default().push(Face { elem: e, local: local as u8 });
            }
        }
    }
    for v in face_sets.values_mut() {
        v.sort_unstable();
    }
    mesh.face_sets = face_sets;
    Ok(mesh)
}
