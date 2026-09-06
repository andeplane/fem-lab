//! 2D sketches: closed loops of lines and arcs, with holes. The input of sheets, extrusions
//! and revolutions, and the boundary of 2D bodies.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::GeomError;

/// One edge of a loop. A loop is a closed sequence: segment k runs from the previous
/// segment's `to` (segment 0 from the last segment's `to`) to its own `to`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Segment {
    /// Straight edge ending at `to`. `tag` names the boundary face this edge produces.
    Line {
        to: [f64; 2],
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tag: Option<String>,
    },
    /// Circular arc about `center` ending at `to`, counter-clockwise when `ccw` is true.
    /// The start point must lie at the same distance from `center` as `to`.
    Arc {
        center: [f64; 2],
        to: [f64; 2],
        ccw: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tag: Option<String>,
    },
}

impl Segment {
    pub fn to(&self) -> [f64; 2] {
        match self {
            Segment::Line { to, .. } | Segment::Arc { to, .. } => *to,
        }
    }
    pub fn tag(&self) -> Option<&str> {
        match self {
            Segment::Line { tag, .. } | Segment::Arc { tag, .. } => tag.as_deref(),
        }
    }
}

/// A closed outer loop and zero or more hole loops.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Sketch {
    pub outer: Vec<Segment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub holes: Vec<Vec<Segment>>,
}

/// A sampled loop: polygon points, and for every edge `j` (from `pts[j]` to `pts[j+1]`,
/// cyclic) the segment index it came from and its tag.
#[derive(Debug, Clone, PartialEq)]
pub struct Loop {
    pub pts: Vec<[f64; 2]>,
    pub seg_of_edge: Vec<usize>,
    pub tags: Vec<String>,
}

impl Loop {
    pub fn signed_area(&self) -> f64 {
        shoelace(&self.pts)
    }
    pub fn contains(&self, p: [f64; 2]) -> bool {
        point_in_polygon(&self.pts, p)
    }
    /// Distance from `p` to edge `j` and the tag of the nearest edge.
    pub fn nearest_edge(&self, p: [f64; 2]) -> (usize, f64) {
        let n = self.pts.len();
        let mut best = (0, f64::INFINITY);
        for j in 0..n {
            let d = point_segment_distance(p, self.pts[j], self.pts[(j + 1) % n]);
            if d < best.1 {
                best = (j, d);
            }
        }
        best
    }
    fn reverse(&mut self) {
        // edge j (pts[j]→pts[j+1]) becomes edge n-1-j of the reversed loop
        self.pts.reverse();
        let n = self.pts.len();
        let seg = self.seg_of_edge.clone();
        let tags = self.tags.clone();
        for j in 0..n {
            self.seg_of_edge[n - 1 - j] = seg[j];
            self.tags[n - 1 - j] = tags[j].clone();
        }
        // after reversing points, the edge that went pts[j]→pts[j+1] is now pts[n-1-j-1]→pts[n-1-j]
        self.seg_of_edge.rotate_left(1);
        self.tags.rotate_left(1);
    }
}

pub fn shoelace(pts: &[[f64; 2]]) -> f64 {
    let n = pts.len();
    let mut a = 0.0;
    for i in 0..n {
        let p = pts[i];
        let q = pts[(i + 1) % n];
        a += p[0] * q[1] - q[0] * p[1];
    }
    0.5 * a
}

pub fn point_in_polygon(pts: &[[f64; 2]], p: [f64; 2]) -> bool {
    let n = pts.len();
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (pts[i][0], pts[i][1]);
        let (xj, yj) = (pts[j][0], pts[j][1]);
        if (yi > p[1]) != (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

pub fn point_segment_distance(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let ab = [b[0] - a[0], b[1] - a[1]];
    let ap = [p[0] - a[0], p[1] - a[1]];
    let l2 = ab[0] * ab[0] + ab[1] * ab[1];
    let t = if l2 == 0.0 { 0.0 } else { ((ap[0] * ab[0] + ap[1] * ab[1]) / l2).clamp(0.0, 1.0) };
    let c = [a[0] + t * ab[0], a[1] + t * ab[1]];
    libm::hypot(p[0] - c[0], p[1] - c[1])
}

fn ang(v: [f64; 2]) -> f64 {
    libm::atan2(v[1], v[0])
}

/// Signed sweep of an arc from `from` to `to` about `center`: positive when ccw, in (0, 2π].
pub fn arc_sweep(from: [f64; 2], center: [f64; 2], to: [f64; 2], ccw: bool) -> f64 {
    let a0 = ang([from[0] - center[0], from[1] - center[1]]);
    let a1 = ang([to[0] - center[0], to[1] - center[1]]);
    let tau = std::f64::consts::TAU;
    // a1 - a0 lies in (-2π, 2π); at most two corrections put it in the right half-open turn
    // (two when the end points coincide up to rounding: a full circle)
    let mut d = a1 - a0;
    if ccw {
        while d <= 1e-12 {
            d += tau;
        }
    } else {
        while d >= -1e-12 {
            d -= tau;
        }
    }
    d
}

fn arc_radius(from: [f64; 2], center: [f64; 2], to: [f64; 2]) -> Result<f64, GeomError> {
    let r0 = libm::hypot(from[0] - center[0], from[1] - center[1]);
    let r1 = libm::hypot(to[0] - center[0], to[1] - center[1]);
    if r0 <= 0.0 || (r0 - r1).abs() > 1e-9 * r0.max(1.0) {
        return Err(GeomError(format!(
            "arc about ({}, {}) has start radius {r0} and end radius {r1}; they must be equal",
            center[0], center[1]
        )));
    }
    Ok(r0)
}

fn sample_loop(segs: &[Segment], chord_tol: f64, prefix: &str) -> Result<Loop, GeomError> {
    if segs.len() < 2 {
        return Err(GeomError("a loop needs at least two segments".into()));
    }
    let start = segs[segs.len() - 1].to();
    let mut pts = vec![start];
    let mut seg_of_edge = Vec::new();
    let mut tags = Vec::new();
    let mut from = start;
    for (k, s) in segs.iter().enumerate() {
        let tag = s.tag().map(str::to_string).unwrap_or_else(|| format!("{prefix}edge{k}"));
        match s {
            Segment::Line { to, .. } => {
                pts.push(*to);
                seg_of_edge.push(k);
                tags.push(tag.clone());
            }
            Segment::Arc { center, to, ccw, .. } => {
                let r = arc_radius(from, *center, *to)?;
                let sweep = arc_sweep(from, *center, *to, *ccw);
                let tol = chord_tol.max(1e-12 * r).min(r);
                let dtheta = 2.0 * libm::acos(1.0 - tol / r);
                let n = libm::ceil(sweep.abs() / dtheta).max(1.0) as usize;
                let a0 = ang([from[0] - center[0], from[1] - center[1]]);
                for i in 1..=n {
                    let a = a0 + sweep * i as f64 / n as f64;
                    let p = if i == n { *to } else { [center[0] + r * libm::cos(a), center[1] + r * libm::sin(a)] };
                    pts.push(p);
                    seg_of_edge.push(k);
                    tags.push(tag.clone());
                }
            }
        }
        from = s.to();
    }
    // the final point equals the start
    pts.pop();
    if pts.len() < 3 {
        return Err(GeomError("a loop needs at least three distinct points".into()));
    }
    Ok(Loop { pts, seg_of_edge, tags })
}

/// Exact signed area of a loop: chord polygon plus circular segments of its arcs.
fn exact_signed_area(segs: &[Segment]) -> Result<f64, GeomError> {
    let start = segs[segs.len() - 1].to();
    let chord: Vec<[f64; 2]> = segs.iter().map(Segment::to).collect();
    let mut a = shoelace(&chord);
    let mut from = start;
    for s in segs {
        if let Segment::Arc { center, to, ccw, .. } = s {
            let r = arc_radius(from, *center, *to)?;
            let th = arc_sweep(from, *center, *to, *ccw).abs();
            let seg_area = 0.5 * r * r * (th - libm::sin(th));
            a += if *ccw { seg_area } else { -seg_area };
        }
        from = s.to();
    }
    Ok(a)
}

/// Chord tolerance used when a sketch is sampled only for point containment.
pub const CONTAINS_TOL_FRACTION: f64 = 1e-4;

impl Sketch {
    pub fn validate(&self) -> Result<(), GeomError> {
        let a = exact_signed_area(self.outer_checked()?)?;
        if a.abs() < 1e-30 {
            return Err(GeomError("the outer loop has zero area".into()));
        }
        for (i, h) in self.holes.iter().enumerate() {
            if h.len() < 2 {
                return Err(GeomError(format!("hole {i} needs at least two segments")));
            }
            let ha = exact_signed_area(h)?;
            if ha.abs() < 1e-30 {
                return Err(GeomError(format!("hole {i} has zero area")));
            }
        }
        Ok(())
    }

    fn outer_checked(&self) -> Result<&[Segment], GeomError> {
        if self.outer.len() < 2 {
            return Err(GeomError("the outer loop needs at least two segments".into()));
        }
        Ok(&self.outer)
    }

    /// Exact area: outer minus holes.
    pub fn area(&self) -> Result<f64, GeomError> {
        let mut a = exact_signed_area(self.outer_checked()?)?.abs();
        for h in &self.holes {
            a -= exact_signed_area(h)?.abs();
        }
        Ok(a)
    }

    /// Sample every loop with the given chord tolerance. The outer loop is returned
    /// counter-clockwise and holes clockwise, whatever the input orientation.
    pub fn loops(&self, chord_tol: f64) -> Result<Vec<Loop>, GeomError> {
        let mut out = Vec::with_capacity(1 + self.holes.len());
        let mut outer = sample_loop(self.outer_checked()?, chord_tol, "")?;
        if outer.signed_area() < 0.0 {
            outer.reverse();
        }
        out.push(outer);
        for (i, h) in self.holes.iter().enumerate() {
            let mut l = sample_loop(h, chord_tol, &format!("hole{i}."))?;
            if l.signed_area() > 0.0 {
                l.reverse();
            }
            out.push(l);
        }
        Ok(out)
    }

    /// Bounding box of the sampled outer loop.
    pub fn bbox(&self) -> Result<([f64; 2], [f64; 2]), GeomError> {
        let l = &self.loops(self.contains_tol()?)?[0];
        let mut lo = [f64::INFINITY; 2];
        let mut hi = [f64::NEG_INFINITY; 2];
        for p in &l.pts {
            for k in 0..2 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
        Ok((lo, hi))
    }

    fn contains_tol(&self) -> Result<f64, GeomError> {
        let chord: Vec<[f64; 2]> = self.outer_checked()?.iter().map(Segment::to).collect();
        let mut lo = [f64::INFINITY; 2];
        let mut hi = [f64::NEG_INFINITY; 2];
        for p in &chord {
            for k in 0..2 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
        let diag = libm::hypot(hi[0] - lo[0], hi[1] - lo[1]).max(1e-300);
        Ok(diag * CONTAINS_TOL_FRACTION)
    }

    /// Point containment on a finely sampled polygon (inside the outer loop, outside every hole).
    pub fn contains(&self, p: [f64; 2]) -> Result<bool, GeomError> {
        let loops = self.loops(self.contains_tol()?)?;
        if !loops[0].contains(p) {
            return Ok(false);
        }
        Ok(!loops[1..].iter().any(|h| h.contains(p)))
    }

    /// A rectangle `[0,w] × [0,h]` with edges tagged `ymin`, `xmax`, `ymax`, `xmin`.
    pub fn rect(w: f64, h: f64) -> Sketch {
        Sketch {
            outer: vec![
                Segment::Line { to: [w, 0.0], tag: Some("ymin".into()) },
                Segment::Line { to: [w, h], tag: Some("xmax".into()) },
                Segment::Line { to: [0.0, h], tag: Some("ymax".into()) },
                Segment::Line { to: [0.0, 0.0], tag: Some("xmin".into()) },
            ],
            holes: vec![],
        }
    }

    /// A full circle of radius `r` about `center` as two ccw arcs, tagged `tag`.
    pub fn circle(center: [f64; 2], r: f64, tag: &str) -> Vec<Segment> {
        vec![
            Segment::Arc { center, to: [center[0] - r, center[1]], ccw: true, tag: Some(tag.into()) },
            Segment::Arc { center, to: [center[0] + r, center[1]], ccw: true, tag: Some(tag.into()) },
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    #[test]
    fn rectangle_area_bbox_contains_and_tags() {
        let s = Sketch::rect(2.0, 1.0);
        s.validate().unwrap();
        assert_eq!(s.area().unwrap(), 2.0);
        assert_eq!(s.bbox().unwrap(), ([0.0, 0.0], [2.0, 1.0]));
        assert!(s.contains([1.0, 0.5]).unwrap());
        assert!(!s.contains([3.0, 0.5]).unwrap());
        let l = &s.loops(0.01).unwrap()[0];
        assert_eq!(l.pts.len(), 4);
        assert_eq!(l.tags, ["ymin", "xmax", "ymax", "xmin"]);
        assert_eq!(l.seg_of_edge, [0, 1, 2, 3]);
        assert!(l.signed_area() > 0.0);
        assert_eq!(l.nearest_edge([1.0, -0.1]), (0, 0.1));
        assert_eq!(l.nearest_edge([2.2, 0.5]).0, 1);
    }

    #[test]
    fn clockwise_input_is_reversed_with_tags_following() {
        let cw = Sketch {
            outer: vec![
                Segment::Line { to: [0.0, 1.0], tag: Some("a".into()) }, // from (0,0) up
                Segment::Line { to: [2.0, 1.0], tag: Some("b".into()) },
                Segment::Line { to: [2.0, 0.0], tag: Some("c".into()) },
                Segment::Line { to: [0.0, 0.0], tag: Some("d".into()) },
            ],
            holes: vec![],
        };
        let l = &cw.loops(0.01).unwrap()[0];
        assert!(l.signed_area() > 0.0);
        // every edge keeps the tag of the geometric edge it lies on
        for j in 0..4 {
            let mid = [(l.pts[j][0] + l.pts[(j + 1) % 4][0]) / 2.0, (l.pts[j][1] + l.pts[(j + 1) % 4][1]) / 2.0];
            let expected = if mid[0] == 0.0 {
                "a"
            } else if mid[1] == 1.0 {
                "b"
            } else if mid[0] == 2.0 {
                "c"
            } else {
                "d"
            };
            assert_eq!(l.tags[j], expected, "edge {j} at {mid:?}");
        }
    }

    #[test]
    fn circle_and_annulus_areas_are_exact() {
        let circle = Sketch { outer: Sketch::circle([0.0, 0.0], 2.0, "rim"), holes: vec![] };
        circle.validate().unwrap();
        assert!((circle.area().unwrap() - 4.0 * PI).abs() < 1e-12);
        let ring = Sketch {
            outer: Sketch::circle([0.0, 0.0], 2.0, "outer"),
            holes: vec![Sketch::circle([0.0, 0.0], 1.0, "inner")],
        };
        ring.validate().unwrap();
        assert!((ring.area().unwrap() - 3.0 * PI).abs() < 1e-12);
        assert!(ring.contains([1.5, 0.0]).unwrap());
        assert!(!ring.contains([0.5, 0.0]).unwrap());
        assert!(!ring.contains([2.5, 0.0]).unwrap());
        let loops = ring.loops(0.001).unwrap();
        assert!(loops[0].signed_area() > 0.0 && loops[1].signed_area() < 0.0);
        assert!(loops[0].pts.len() > 40);
        assert!(loops[0].tags.iter().all(|t| t == "outer"));
        assert!(loops[1].tags.iter().all(|t| t == "inner"));
        // a clockwise-defined hole keeps its tags too
        let cw_hole: Vec<Segment> = vec![
            Segment::Arc { center: [0.0, 0.0], to: [-1.0, 0.0], ccw: false, tag: None },
            Segment::Arc { center: [0.0, 0.0], to: [1.0, 0.0], ccw: false, tag: None },
        ];
        let ring2 = Sketch { outer: Sketch::circle([0.0, 0.0], 2.0, "outer"), holes: vec![cw_hole] };
        assert!((ring2.area().unwrap() - 3.0 * PI).abs() < 1e-12);
        let l2 = ring2.loops(0.001).unwrap();
        assert!(l2[1].tags.iter().all(|t| t == "hole0.edge0" || t == "hole0.edge1"));
        assert!(l2[1].signed_area() < 0.0);
    }

    #[test]
    fn quarter_annulus_with_arcs_both_ways() {
        // (1,0) → (2,0) → arc ccw to (0,2) → (0,1) → arc cw to (1,0)
        let q = Sketch {
            outer: vec![
                Segment::Line { to: [2.0, 0.0], tag: Some("ymin".into()) },
                Segment::Arc { center: [0.0, 0.0], to: [0.0, 2.0], ccw: true, tag: Some("outer".into()) },
                Segment::Line { to: [0.0, 1.0], tag: Some("xmin".into()) },
                Segment::Arc { center: [0.0, 0.0], to: [1.0, 0.0], ccw: false, tag: Some("inner".into()) },
            ],
            holes: vec![],
        };
        q.validate().unwrap();
        assert!((q.area().unwrap() - 0.25 * PI * 3.0).abs() < 1e-12);
        let (lo, hi) = q.bbox().unwrap();
        assert!(lo[0].abs() < 1e-9 && (hi[0] - 2.0).abs() < 1e-9 && (hi[1] - 2.0).abs() < 1e-9);
        assert!(q.contains([1.0, 1.0]).unwrap());
        assert!(!q.contains([0.5, 0.5]).unwrap());
        let sweep = arc_sweep([2.0, 0.0], [0.0, 0.0], [0.0, 2.0], true);
        assert!((sweep - PI / 2.0).abs() < 1e-12);
        let sweep = arc_sweep([0.0, 1.0], [0.0, 0.0], [1.0, 0.0], false);
        assert!((sweep + PI / 2.0).abs() < 1e-12);
        // full-turn sweeps: from == to
        assert!((arc_sweep([1.0, 0.0], [0.0, 0.0], [1.0, 0.0], true) - 2.0 * PI).abs() < 1e-12);
        assert!((arc_sweep([1.0, 0.0], [0.0, 0.0], [1.0, 0.0], false) + 2.0 * PI).abs() < 1e-12);
        // wrap-around normalisation both ways
        assert!((arc_sweep([0.0, -1.0], [0.0, 0.0], [0.0, 1.0], true) - PI).abs() < 1e-12);
        assert!((arc_sweep([0.0, 1.0], [0.0, 0.0], [0.0, -1.0], false) + PI).abs() < 1e-12);
        assert!((arc_sweep([-1.0, 1e-13], [0.0, 0.0], [-1.0, -1e-13], true) - 2.0 * PI).abs() < 1e-6);
        assert!((arc_sweep([-1.0, -1e-13], [0.0, 0.0], [-1.0, 1e-13], false) + 2.0 * PI).abs() < 1e-6);
    }

    #[test]
    fn errors() {
        let one = Sketch { outer: vec![Segment::Line { to: [1.0, 0.0], tag: None }], holes: vec![] };
        assert!(one.validate().unwrap_err().0.contains("two segments"));
        assert!(one.area().is_err());
        assert!(one.loops(0.1).is_err());
        assert!(one.bbox().is_err());
        assert!(one.contains([0.0, 0.0]).is_err());
        let flat = Sketch {
            outer: vec![Segment::Line { to: [1.0, 0.0], tag: None }, Segment::Line { to: [0.0, 0.0], tag: None }],
            holes: vec![],
        };
        assert!(flat.validate().unwrap_err().0.contains("zero area"));
        assert!(flat.loops(0.1).unwrap_err().0.contains("three distinct points"));
        let bad_arc = Sketch {
            outer: vec![
                Segment::Line { to: [2.0, 0.0], tag: None },
                Segment::Arc { center: [0.0, 0.0], to: [0.0, 1.0], ccw: true, tag: None },
                Segment::Line { to: [0.0, 0.0], tag: None },
            ],
            holes: vec![],
        };
        assert!(bad_arc.validate().unwrap_err().0.contains("must be equal"));
        assert!(bad_arc.loops(0.1).is_err());
        assert!(bad_arc.bbox().is_err());
        assert!(flat.bbox().is_err());
        let mut hole_bad = Sketch::rect(4.0, 4.0);
        hole_bad.holes.push(vec![Segment::Line { to: [1.0, 1.0], tag: None }]);
        assert!(hole_bad.validate().unwrap_err().0.contains("hole 0 needs"));
        assert!(hole_bad.loops(0.1).unwrap_err().0.contains("two segments"));
        hole_bad.holes =
            vec![vec![Segment::Line { to: [1.0, 1.0], tag: None }, Segment::Line { to: [2.0, 2.0], tag: None }]];
        assert!(hole_bad.validate().unwrap_err().0.contains("hole 0 has zero area"));
        let mut hole_arc_bad = Sketch::rect(4.0, 4.0);
        hole_arc_bad.holes.push(vec![
            Segment::Line { to: [2.0, 1.0], tag: None },
            Segment::Arc { center: [2.0, 2.0], to: [2.5, 2.0], ccw: true, tag: None },
        ]);
        assert!(hole_arc_bad.validate().is_err());
        assert!(hole_arc_bad.area().is_err());
        assert!(hole_arc_bad.loops(0.1).is_err());
        assert!(hole_arc_bad.contains([0.5, 0.5]).is_err());
    }

    #[test]
    fn helpers() {
        assert_eq!(point_segment_distance([0.0, 1.0], [0.0, 0.0], [0.0, 0.0]), 1.0);
        assert_eq!(point_segment_distance([5.0, 0.0], [0.0, 0.0], [1.0, 0.0]), 4.0);
        assert!(!point_in_polygon(&[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]], [0.2, 0.8]));
        let s = Segment::Arc { center: [0.0, 0.0], to: [1.0, 0.0], ccw: true, tag: Some("t".into()) };
        assert_eq!(s.tag(), Some("t"));
        assert_eq!(s.to(), [1.0, 0.0]);
        let j = serde_json::to_string(&Sketch::rect(1.0, 1.0)).unwrap();
        assert!(j.contains("\"kind\":\"line\""));
        assert!(!j.contains("holes"));
        let back: Sketch = serde_json::from_str(&j).unwrap();
        assert_eq!(back, Sketch::rect(1.0, 1.0));
    }
}
