//! Sweeping a 2D quad mesh into a 3D hex mesh (C §2.7 "Sweep"): straight extrusion along z,
//! and revolution of an `(r, z)` section about the z axis.
//!
//! quad4 gives hex8 and quad8 gives hex20. A hex20 has no face-centre node, so only the layers
//! at integer parameter carry the base's mid-edge nodes; the half layers carry the base's
//! corner nodes alone, which is exactly the hex20 node set. A revolution puts those half-layer
//! nodes at the half angle, so they lie on the arc and the element is second-order accurate on
//! a curved boundary. The base's edge face sets are swept into side face sets of the same
//! names; the ends become `bottom`/`top` (extrusion) or `theta0`/`theta1` (revolution below a
//! full turn, which merges its seam instead).

use std::collections::BTreeMap;

use crate::mesh::{ElementBlock, ElementKind, Face, Mesh};
use crate::GeomError;

/// The sweep of a 2D base mesh through `intervals` steps of a one-parameter family of
/// placements.
struct Sweep {
    /// hex8 or hex20.
    kind: ElementKind,
    /// Parameter steps per element: 1 for hex8, 2 for hex20 (the half layers).
    s: usize,
    intervals: usize,
    /// The last level is the first one again (a full revolution).
    wrap: bool,
    /// The element's Abaqus "bottom" is the higher parameter, which keeps a revolution of a
    /// counter-clockwise `(r, z)` section positively oriented.
    flip: bool,
    /// Face-set names of the faces at parameter 0 and at the last parameter.
    caps: Option<[&'static str; 2]>,
}

/// The base kinds a sweep accepts, and what they sweep into.
fn swept_kind(base: &Mesh) -> Result<(ElementKind, usize), GeomError> {
    if base.dim != 2 {
        return Err(GeomError(format!("a sweep needs a 2D base mesh, got a {}D one", base.dim)));
    }
    if base.blocks.len() != 1 {
        return Err(GeomError(format!(
            "a sweep needs a base mesh of one element kind, got {} blocks",
            base.blocks.len()
        )));
    }
    match base.blocks[0].kind {
        ElementKind::Quad4 => Ok((ElementKind::Hex8, 1)),
        ElementKind::Quad8 => Ok((ElementKind::Hex20, 2)),
        k => Err(GeomError(format!("a sweep needs a quad4 or quad8 base mesh, got {k:?}"))),
    }
}

impl Sweep {
    /// `place(level, [x, y])` is the 3D position of base point `[x, y]` at half-level `level`.
    fn run(&self, base: &Mesh, place: &dyn Fn(usize, [f64; 2]) -> [f64; 3]) -> Mesh {
        let nb = base.n_nodes();
        let ne = base.n_elems();
        let mut is_corner = vec![false; nb];
        for e in 0..ne as u32 {
            for &n in &base.elem_nodes(e)[..4] {
                is_corner[n as usize] = true;
            }
        }
        let n_levels = self.s * self.intervals + usize::from(!self.wrap);
        let mut ids = vec![u32::MAX; n_levels * nb];
        let mut coords = Vec::new();
        for lv in 0..n_levels {
            for n in 0..nb {
                if lv % self.s != 0 && !is_corner[n] {
                    continue; // a half layer carries the corner nodes only
                }
                ids[lv * nb + n] = (coords.len() / 3) as u32;
                let p = base.node(n as u32);
                coords.extend_from_slice(&place(lv, [p[0], p[1]]));
            }
        }
        let at = |lv: usize, n: u32| ids[(lv % n_levels) * nb + n as usize];

        let mut conn = Vec::new();
        for i in 0..self.intervals {
            let (lo, hi) = if self.flip { (self.s * (i + 1), self.s * i) } else { (self.s * i, self.s * (i + 1)) };
            for e in 0..ne as u32 {
                let en = base.elem_nodes(e);
                conn.extend(en[..4].iter().map(|&n| at(lo, n)));
                conn.extend(en[..4].iter().map(|&n| at(hi, n)));
                if self.s == 2 {
                    conn.extend(en[4..8].iter().map(|&n| at(lo, n)));
                    conn.extend(en[4..8].iter().map(|&n| at(hi, n)));
                    conn.extend(en[..4].iter().map(|&n| at(self.s * i + 1, n)));
                }
            }
        }

        // A base edge `local` sweeps into the hex side face `local + 2` (S3..S6).
        let mut face_sets: BTreeMap<String, Vec<Face>> = BTreeMap::new();
        for (name, faces) in &base.face_sets {
            let mut v: Vec<Face> = (0..self.intervals)
                .flat_map(|i| faces.iter().map(move |f| Face { elem: (i * ne) as u32 + f.elem, local: f.local + 2 }))
                .collect();
            v.sort_unstable();
            face_sets.insert(name.clone(), v);
        }
        if let Some([first, last]) = self.caps {
            let (a, b) = if self.flip { (1, 0) } else { (0, 1) };
            let cap = |i: usize, local: u8| (0..ne as u32).map(|e| Face { elem: (i * ne) as u32 + e, local }).collect();
            face_sets.insert(first.to_string(), cap(0, a));
            face_sets.insert(last.to_string(), cap(self.intervals - 1, b));
        }
        let n_elems = (self.intervals * ne) as u32;
        Mesh {
            dim: 3,
            coords,
            blocks: vec![ElementBlock { kind: self.kind, conn, first_elem: 0 }],
            node_sets: BTreeMap::new(),
            elem_sets: BTreeMap::from([("all".to_string(), (0..n_elems).collect())]),
            face_sets,
        }
    }
}

/// Extrude a 2D quad mesh along z into `layers` layers of total `height`.
///
/// quad4 becomes hex8 and quad8 hex20. The base's edge face sets become side face sets of the
/// same names; the ends are `bottom` (z = 0) and `top` (z = height), and the element set `all`
/// holds every element.
pub fn extrude(base: &Mesh, layers: usize, height: f64) -> Result<Mesh, GeomError> {
    let (kind, s) = swept_kind(base)?;
    if layers == 0 {
        return Err(GeomError("an extrusion needs at least one layer".into()));
    }
    if !(height.is_finite() && height > 0.0) {
        return Err(GeomError(format!("the extrusion height is {height}; it must be finite and positive")));
    }
    let sweep = Sweep { kind, s, intervals: layers, wrap: false, flip: false, caps: Some(["bottom", "top"]) };
    let dz = height / (s * layers) as f64;
    Ok(sweep.run(base, &|lv, p| [p[0], p[1], lv as f64 * dz]))
}

/// Revolve a 2D mesh of an `(r, z)` section (x is the radius, y the axis coordinate) about the
/// z axis through `angle_deg` in `segments` circumferential steps.
///
/// quad4 becomes hex8 and quad8 hex20, whose circumferential mid-nodes sit at the half angle
/// and so lie on the arc. A full turn merges the seam; below one, the ends are the face sets
/// `theta0` and `theta1`. The base's edge face sets become side face sets of the same names.
/// A node at r = 0 is refused: mesh a solid section as a butterfly block set and extrude it.
pub fn revolve(base: &Mesh, segments: usize, angle_deg: f64) -> Result<Mesh, GeomError> {
    let (kind, s) = swept_kind(base)?;
    if segments == 0 {
        return Err(GeomError("a revolution needs at least one segment".into()));
    }
    if !(angle_deg.is_finite() && angle_deg > 0.0 && angle_deg <= 360.0) {
        return Err(GeomError(format!("the revolution angle is {angle_deg}°; it must be in (0, 360]")));
    }
    let r_max = base.coords.chunks_exact(3).fold(0.0f64, |m, p| m.max(p[0]));
    if let Some(p) = base.coords.chunks_exact(3).find(|p| p[0] <= 1e-12 * r_max) {
        return Err(GeomError(format!(
            "the base has a node at radius {} (x = r), and a revolution about z needs r > 0; \
             mesh the section as a butterfly block set and extrude it instead",
            p[0]
        )));
    }
    let wrap = (angle_deg - 360.0).abs() < 1e-12;
    let caps = if wrap { None } else { Some(["theta0", "theta1"]) };
    let sweep = Sweep { kind, s, intervals: segments, wrap, flip: true, caps };
    let dt = angle_deg.to_radians() / (s * segments) as f64;
    Ok(sweep.run(base, &|lv, p| {
        let t = lv as f64 * dt;
        [p[0] * libm::cos(t), p[0] * libm::sin(t), p[1]]
    }))
}
