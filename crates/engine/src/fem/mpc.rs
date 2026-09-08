//! Multipoint constraints: `u_slave = Σ a·u_master`, applied by elimination (plan B §1).
//!
//! A tie between two parts is a linear relation between DOFs, and there are three ways to
//! impose one. A penalty spring multiplies the condition number of `K` by however stiff the
//! spring is, which is the first thing that breaks the f32 GPU CG (ADR 0002). Lagrange
//! multipliers make the system indefinite, and both `solve::direct` (a faer **Cholesky**) and
//! `solve::pcg` / `gpu::cg` (conjugate gradients) need it positive definite. So the engine
//! eliminates: with `T` the n×n matrix that is the identity on the retained DOFs and carries
//! the coefficients on a slave row, the solved system is `TᵀKT v = Tᵀf` with the slave DOFs
//! dropped from the free set, and the slave values are put back afterwards by [`recover`].
//! `TᵀKT` is symmetric for any `T` and positive definite whenever `T` has full column rank,
//! which the dependency check below enforces, and κ(K') ≈ κ(K).
//!
//! A bonded tie, a coupling and a cyclic tie are homogeneous, `u_s − Σ a u_m = 0`. A
//! frictionless contact (#62) is the one inhomogeneous relation: an active slave node is held
//! on the master surface by `(u_s − Σ a u_m)·n = −g₀`, so `u = T v + g` and the solved system is
//! `TᵀKT v = Tᵀ(f − K g)` with [`recover`] adding `g` back. `g` is exactly zero on every other
//! row, and [`transform`] takes the homogeneous path when no row carries one, so a bonded
//! fixture is bit-identical to what it was before this branch existed.
//!
//! [`build`] is a pure function of the [`Problem`] and its Mesh with no cached state. It pairs
//! every frictionless candidate once, at the reference configuration, and builds the rows of
//! *all* of them — the most constrained set, which is what the well-posedness checks want to
//! see; [`Mpc::with_active`] then hands the procedures the rows of whichever subset the active
//! set of [`crate::fem::contact`] currently holds, as often as it changes.

use std::collections::{BTreeMap, BTreeSet};

use femlab_geometry::mesh::{Face, FaceKind};
use femlab_geometry::Mesh;

use crate::command::CoupleKind;
use crate::error::{Error, ErrorCode, Warning};
use crate::fem::assembly::Csr;
use crate::fem::heat::{face_integrals, HeatLoad};
use crate::fem::problem::{Coupling, Problem};
use crate::fem::shape::{face_dshape_of, face_shape_of};
use crate::mesh::ResolvedSet;
use crate::par;

/// Gauss–Newton steps taken to project a node onto a face. A planar face converges in one; six
/// is ample for the curved faces of a quadratic element.
const PROJECT_STEPS: usize = 6;
/// A pairing gap above this fraction of the mesh bounding-box diagonal is reported as a
/// `contact.gap` warning even when it is inside the tolerance.
const GAP_WARN: f64 = 1e-9;
/// Weights below this are the projection's own rounding, not a coupling: a node that lands on
/// a face corner gets a shape function of exactly 1 there and 1e-17 at a neighbour. Dropping
/// them keeps a matched tie exactly node-to-node, which is what makes it cost nothing.
const WEIGHT_EPS: f64 = 1e-12;

/// One eliminated DOF: `u[slave] = Σ coeff · u[master] + g`. `g` is zero on every row but an
/// active frictionless candidate's.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub slave: u32,
    pub masters: Vec<(u32, f64)>,
    /// The inhomogeneous part: `−g₀ / n_k` for a contact row, `0` otherwise.
    pub g: f64,
    /// Index into [`Problem::couplings`], so every error and warning names its Command.
    pub owner: usize,
}

/// One slave node of a frictionless contact that the search found within `tol` of its master:
/// where it projects, which way the master faces there, and how far apart the two are before
/// any load. All of it is fixed at the reference configuration (small sliding).
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub node: u32,
    /// `(master node, shape-function weight)` of the projection point.
    pub masters: Vec<(u32, f64)>,
    /// Unit normal of the master face at the projection, pointing out of the master Body —
    /// towards the slave when the gap is open.
    pub normal: [f64; 3],
    /// The initial gap along `normal`, positive when open, in metres.
    pub gap: f64,
    /// The slave component the relation is eliminated on: the one with the largest `|n_k|`, so
    /// the coefficients `n_j / n_k` are all at most one in magnitude.
    pub comp: usize,
    /// Index into [`Problem::couplings`].
    pub owner: usize,
}

impl Candidate {
    /// The row that holds this node on the master surface: `u_s,k` in terms of the other slave
    /// components and the master DOFs, with `g = −gap / n_k`.
    fn row(&self, dpn: usize, inhomogeneous: bool) -> Row {
        let nk = self.normal[self.comp];
        let dpn32 = dpn as u32;
        let comps = dpn.min(3);
        let mut masters = Vec::new();
        for j in (0..comps).filter(|&j| j != self.comp) {
            let a = -self.normal[j] / nk;
            if a.abs() > WEIGHT_EPS {
                masters.push((self.node * dpn32 + j as u32, a));
            }
        }
        for &(m, w) in &self.masters {
            for j in 0..comps {
                let a = w * self.normal[j] / nk;
                if a.abs() > WEIGHT_EPS {
                    masters.push((m * dpn32 + j as u32, a));
                }
            }
        }
        let g = if inhomogeneous { -self.gap / nk } else { 0.0 };
        Row { slave: self.node * dpn32 + self.comp as u32, masters, g, owner: self.owner }
    }

    /// The DOF the row eliminates.
    pub fn slave_dof(&self, dpn: usize) -> u32 {
        self.node * dpn as u32 + self.comp as u32
    }

    /// `(u_s − Σ a·u_m)·n`: how much the pair has closed (negative) or opened (positive) under
    /// the displacement `u`, before the initial gap is added.
    pub fn relative_normal(&self, u: &[f64], dpn: usize) -> f64 {
        let comps = dpn.min(3);
        let at = |node: u32| -> f64 { (0..comps).map(|j| self.normal[j] * u[node as usize * dpn + j]).sum::<f64>() };
        at(self.node) - self.masters.iter().map(|&(m, w)| w * at(m)).sum::<f64>()
    }
}

/// Every multipoint constraint of one Problem, sorted by slave DOF.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Mpc {
    /// Ascending by `slave`.
    pub rows: Vec<Row>,
    /// The same slaves, ascending: the `eliminated` list [`crate::fem::assembly::reduce`] wants.
    pub slaves: Vec<u32>,
    /// The rows of a bonded contact a `contact.thermal` names, ascending by `slave`. These are
    /// the tie [`build`] built and then *excluded* from `rows`/`slaves`: a `contact.thermal`
    /// replaces the perfect thermal tie with a finite conductance, so its node stays a free
    /// unknown rather than an eliminated one, and `heat::assemble` reads these rows directly to
    /// add that conductance to `K` (plan B §5). Empty for every Problem without one.
    pub contact: Vec<Row>,
    /// Every paired node of every frictionless contact, in coupling order then slave-node
    /// order. [`build`] puts all of their rows in `rows`; [`Mpc::with_active`] keeps a subset.
    pub candidates: Vec<Candidate>,
    /// A gap smaller than this is closed: the pairing's own rounding, `1e-9` of the Mesh
    /// diagonal.
    pub gap_tol: f64,
    pub warnings: Vec<Warning>,
}

impl Mpc {
    /// No constraints at all: what a Problem without couplings gets, and the identity `T`.
    pub fn none() -> Mpc {
        Mpc::default()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Does any row carry an inhomogeneous part, so [`transform`] has a `K g` to subtract.
    pub fn inhomogeneous(&self) -> bool {
        self.rows.iter().any(|r| r.g != 0.0)
    }

    /// The same constraints with only the frictionless candidates `active` marks kept, their
    /// rows carrying `g = −g₀/n_k` when `inhomogeneous` (the solve for `u` itself) and zero
    /// otherwise (a Newton correction, which must leave a satisfied constraint satisfied).
    ///
    /// Every row [`build`] made for a candidate is in `rows`, so this is a filter, not a
    /// rebuild: the dependency check has already passed on the superset.
    pub fn with_active(&self, active: &[bool], inhomogeneous: bool, dpn: usize) -> Mpc {
        let of: BTreeMap<u32, usize> = self.candidates.iter().enumerate().map(|(i, c)| (c.slave_dof(dpn), i)).collect();
        let rows: Vec<Row> = self
            .rows
            .iter()
            .filter(|r| of.get(&r.slave).is_none_or(|&i| active[i]))
            .map(|r| Row { g: if inhomogeneous { r.g } else { 0.0 }, ..r.clone() })
            .collect();
        let slaves = rows.iter().map(|r| r.slave).collect();
        Mpc {
            rows,
            slaves,
            contact: self.contact.clone(),
            candidates: self.candidates.clone(),
            gap_tol: self.gap_tol,
            warnings: self.warnings.clone(),
        }
    }

    /// Every `[slave node, master node]` pair the rows couple, ascending and unique. This is
    /// what [`crate::fem::assembly::pattern_coupled`] needs to make room for entries that no
    /// element creates.
    pub fn pairs(&self, dofs_per_node: usize) -> Vec<[u32; 2]> {
        let dpn = dofs_per_node as u32;
        let mut out: Vec<[u32; 2]> = self
            .rows
            .iter()
            .flat_map(|r| {
                let slave = r.slave / dpn;
                r.masters.iter().map(move |&(m, _)| [slave, m / dpn])
            })
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Every node pair a thermal contact's excluded rows put an entry of `K` at directly: the
    /// slave with each master, and every master with every other, since the added fill is the
    /// full outer product `w(eₙ − Σaₖeₖ)(eₙ − Σaₖeₖ)ᵀ`. Heat has one DOF per node, so this is
    /// already node-indexed — what [`crate::fem::assembly::pattern_coupled`] needs to make room
    /// for the entries [`transform`] would otherwise have built for free.
    pub fn contact_pairs(&self) -> Vec<[u32; 2]> {
        let mut out = Vec::new();
        for row in &self.contact {
            let nodes: Vec<u32> = std::iter::once(row.slave).chain(row.masters.iter().map(|&(m, _)| m)).collect();
            for (i, &a) in nodes.iter().enumerate() {
                for &b in &nodes[i + 1..] {
                    out.push([a.min(b), a.max(b)]);
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// The row that eliminates `dof`, if any.
    fn row_of(&self, dof: u32) -> Option<&Row> {
        self.slaves.binary_search(&dof).ok().map(|i| &self.rows[i])
    }
}

/// Every multipoint constraint of a Problem, or the first failure.
///
/// Pure: it reads the Problem and its Mesh and caches nothing, so a Newton loop may call it
/// once per iteration.
pub fn build(p: &Problem<'_>) -> Result<Mpc, Error> {
    // A heat Problem's temperature tie is one row per node (`dofs_per_node() == 1`); a
    // `contact.thermal` names the Coupling whose row that is and asks for it to stay a free
    // unknown instead. A structural Problem never sees this: its `heat_loads` are always empty,
    // so the mechanical tie of the very same Coupling is unaffected, exactly as the doc string
    // for `contact.thermal` says.
    let thermal_of: BTreeSet<&str> = if p.heat {
        p.heat_loads
            .iter()
            .filter_map(|l| match l {
                HeatLoad::Contact { of, .. } => Some(of.as_str()),
                HeatLoad::Convection { .. }
                | HeatLoad::Flux { .. }
                | HeatLoad::Source { .. }
                | HeatLoad::Radiation { .. } => None,
            })
            .collect()
    } else {
        BTreeSet::new()
    };
    let mut rows: Vec<Row> = Vec::new();
    let mut contact: Vec<Row> = Vec::new();
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut warnings: Vec<Warning> = Vec::new();
    let dpn = p.dofs_per_node();
    let (lo, hi) = p.mesh.bbox();
    let diag = ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2) + (hi[2] - lo[2]).powi(2)).sqrt();
    let gap_tol = GAP_WARN * diag;
    for (owner, c) in p.couplings.iter().enumerate() {
        let mut produced: Vec<Row> = Vec::new();
        match c {
            Coupling::Bonded { name, master, slave, tol } => {
                bonded_rows(p, name, master, slave, *tol, owner, &mut produced, &mut warnings)?;
            }
            // A heat Step refuses a frictionless pair by name (`checks::all`), so its
            // candidates are not built there: a temperature has no gap to open.
            Coupling::Frictionless { name, master, slave, tol } if !p.heat => {
                let first = candidates.len();
                frictionless_candidates(p, name, master, slave, *tol, owner, &mut candidates, &mut warnings)?;
                produced.extend(candidates[first..].iter().map(|c| c.row(dpn, true)));
            }
            Coupling::Frictionless { .. } => {}
            Coupling::Cyclic { name, from, to, axis, through, angle, tol } => {
                cyclic_rows(p, name, from, to, *axis, *through, *angle, *tol, owner, &mut rows)?;
            }
            Coupling::Couple { name, node, faces, kind, .. } => {
                couple_rows(p, name, *node, faces, *kind, owner, &mut produced)?;
            }
        }
        // `contact.thermal` only ever names a bonded contact (the Command checks), so a
        // coupling's rows always stay mechanical ties.
        if thermal_of.contains(c.name()) {
            contact.extend(produced);
        } else {
            rows.extend(produced);
        }
    }
    rows.sort_by_key(|r| r.slave);
    contact.sort_by_key(|r| r.slave);
    let mut slaves: Vec<u32> = Vec::with_capacity(rows.len());
    for (i, row) in rows.iter().enumerate() {
        if i > 0 && rows[i - 1].slave == row.slave {
            return Err(dependent(p, row.slave, dpn, rows[i - 1].owner, row.owner, "is tied twice"));
        }
        slaves.push(row.slave);
    }
    let by_slave: BTreeSet<u32> = slaves.iter().copied().collect();
    for row in &rows {
        for &(m, _) in &row.masters {
            if by_slave.contains(&m) {
                let other = rows[slaves.binary_search(&m).expect("m is a slave")].owner;
                return Err(dependent(p, m, dpn, other, row.owner, "is both a slave and a master"));
            }
        }
    }
    Ok(Mpc { rows, slaves, contact, candidates, gap_tol, warnings })
}

/// The `constraint.dependent` error: a DOF that two couplings both eliminate, or that one
/// eliminates while another leans on it. Either makes `T` rank-deficient.
fn dependent(p: &Problem<'_>, dof: u32, dpn: usize, first: usize, second: usize, what: &str) -> Error {
    let comp = p.dof_labels()[dof as usize % dpn];
    let (a, b) = (p.couplings[first].name(), p.couplings[second].name());
    Error::new(
        ErrorCode::ConstraintDependent,
        format!("{comp} of node {} {what}: '{a}' and '{b}' both constrain it", dof as usize / dpn),
    )
    .at(format!("{} '{b}'", p.couplings[second].label()))
    .suggest("constraint.remove one of them, or tie faces that do not overlap")
}

/// The two Sets of a contact pair, checked: the master has faces to project onto, and the two
/// share no node. A slave side coarser than its master is the `contact.slave-coarser` warning,
/// for either kind of contact.
fn pair_sets<'p>(
    p: &'p Problem<'_>,
    name: &str,
    master: &str,
    slave: &str,
    warnings: &mut Vec<Warning>,
) -> Result<(&'p [Face], &'p ResolvedSet), Error> {
    let at = || format!("contact '{name}'");
    let faces = &p.set(master).map_err(|e| e.at(at()))?.faces;
    let slave_set = p.set(slave).map_err(|e| e.at(at()))?;
    if faces.is_empty() {
        return Err(Error::schema(format!("the master of contact '{name}' is set '{master}', which has no faces"))
            .at(at())
            .suggest("contact.add with a face Set as the master, from geometry.nameFace or an auto face"));
    }
    let master_nodes: BTreeSet<u32> = faces.iter().flat_map(|&f| p.mesh.face_nodes(f)).collect();
    if let Some(&shared) = slave_set.nodes.iter().find(|n| master_nodes.contains(n)) {
        return Err(Error::new(
            ErrorCode::ModelIllPosed,
            format!("contact '{name}' ties node {shared} to itself: sets '{master}' and '{slave}' share it"),
        )
        .at(at())
        .suggest("contact.add between the facing Sets of two different Bodies"));
    }
    if slave_set.nodes.len() < master_nodes.len() {
        warnings.push(Warning {
            code: "contact.slave-coarser".into(),
            text: format!(
                "contact '{name}' has {} nodes on the slave set '{slave}' against {} on the master '{master}'; \
                 a node-to-face tie passes the patch test with the finer mesh as the slave",
                slave_set.nodes.len(),
                master_nodes.len()
            ),
            where_: Some(at()),
        });
    }
    Ok((faces.as_slice(), slave_set))
}

/// The candidates of one frictionless contact: every node of the face Set `slave` within `tol`
/// of `master`, paired with its projection, the master normal there and the initial gap.
///
/// A node further away than `tol` is not an error — the search distance is what `tol` means
/// for this kind — but a pair with no candidate at all is `contact.unpaired`: two faces that
/// can never touch are a Model mistake, not a load case.
#[allow(clippy::too_many_arguments)]
fn frictionless_candidates(
    p: &Problem<'_>,
    name: &str,
    master: &str,
    slave: &str,
    tol: f64,
    owner: usize,
    out: &mut Vec<Candidate>,
    warnings: &mut Vec<Warning>,
) -> Result<(), Error> {
    let at = || format!("contact '{name}'");
    let (faces, slave_set) = pair_sets(p, name, master, slave, warnings)?;
    if slave_set.faces.is_empty() {
        return Err(Error::schema(format!(
            "the slave of frictionless contact '{name}' is set '{slave}', which has no faces to carry a pressure on"
        ))
        .at(at())
        .suggest("contact.add with a face Set as the slave, from geometry.nameFace or an auto face"));
    }
    let first = out.len();
    let comps = p.dofs_per_node().min(3);
    for &node in &slave_set.nodes {
        let x = p.mesh.node(node);
        let (distance, face, s) = nearest(p.mesh, faces, x);
        // `NaN <= tol` is false, so a degenerate master face pairs nothing rather than
        // something wrong.
        if !(distance <= tol) {
            continue;
        }
        let fk = p.mesh.kind_of(face.elem).face_kind();
        let mut w = vec![0.0; fk.n_nodes()];
        face_shape_of(fk, s, &mut w);
        let nodes: Vec<u32> = p.mesh.face_nodes(face).collect();
        let normal = outward_normal(p.mesh, face, s);
        let projected: [f64; 3] = {
            let mut y = [0.0; 3];
            for (&n, &wi) in nodes.iter().zip(&w) {
                let c = p.mesh.node(n);
                for k in 0..3 {
                    y[k] += wi * c[k];
                }
            }
            y
        };
        let gap = dot3([x[0] - projected[0], x[1] - projected[1], x[2] - projected[2]], normal);
        let comp = (0..comps).max_by(|&a, &b| normal[a].abs().total_cmp(&normal[b].abs())).expect("a component");
        let masters = nodes.iter().zip(&w).filter(|(_, &wi)| wi.abs() > WEIGHT_EPS).map(|(&m, &wi)| (m, wi)).collect();
        out.push(Candidate { node, masters, normal, gap, comp, owner });
    }
    if out.len() == first {
        return Err(Error::new(
            ErrorCode::ContactUnpaired,
            format!(
                "contact '{name}': no node of set '{slave}' is within the search distance {tol} m of set '{master}'"
            ),
        )
        .at(at())
        .suggest("contact.add with a larger tol, or move the two Bodies until their faces are near each other"));
    }
    Ok(())
}

/// The unit normal of `face` at face coordinates `s`, pointing out of its element.
///
/// The cross product of the two tangents (or the in-plane normal of an edge's one tangent) has
/// a sign that depends on the face's node order; rather than trust a convention, it is turned to
/// point from the element's centroid towards the face.
fn outward_normal(mesh: &Mesh, face: Face, s: [f64; 2]) -> [f64; 3] {
    let fk = mesh.kind_of(face.elem).face_kind();
    let coords: Vec<[f64; 3]> = mesh.face_nodes(face).map(|n| mesh.node(n)).collect();
    let mut ds = vec![[0.0; 2]; fk.n_nodes()];
    face_dshape_of(fk, s, &mut ds);
    let mut t = [[0.0; 3]; 2];
    for (c, g) in coords.iter().zip(&ds) {
        for k in 0..3 {
            t[0][k] += g[0] * c[k];
            t[1][k] += g[1] * c[k];
        }
    }
    let mut n = if n_par(fk) == 1 {
        [t[0][1], -t[0][0], 0.0]
    } else {
        [
            t[0][1] * t[1][2] - t[0][2] * t[1][1],
            t[0][2] * t[1][0] - t[0][0] * t[1][2],
            t[0][0] * t[1][1] - t[0][1] * t[1][0],
        ]
    };
    let len = dot3(n, n).sqrt();
    for k in 0..3 {
        n[k] /= len;
    }
    let inside = {
        let nodes = mesh.elem_nodes(face.elem);
        let mut c = [0.0; 3];
        for &node in nodes {
            let x = mesh.node(node);
            for k in 0..3 {
                c[k] += x[k] / nodes.len() as f64;
            }
        }
        c
    };
    let on_face = face_centroid(mesh, face);
    if dot3(n, [on_face[0] - inside[0], on_face[1] - inside[1], on_face[2] - inside[2]]) < 0.0 {
        for k in 0..3 {
            n[k] = -n[k];
        }
    }
    n
}

/// The rows of one bonded contact: every node of `slave` tied to the point it projects onto in
/// `master`, in every component.
#[allow(clippy::too_many_arguments)]
fn bonded_rows(
    p: &Problem<'_>,
    name: &str,
    master: &str,
    slave: &str,
    tol: f64,
    owner: usize,
    out: &mut Vec<Row>,
    warnings: &mut Vec<Warning>,
) -> Result<(), Error> {
    let at = || format!("contact '{name}'");
    let (faces, slave_set) = pair_sets(p, name, master, slave, warnings)?;
    let dpn = p.dofs_per_node();
    let (lo, hi) = p.mesh.bbox();
    let diag = ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2) + (hi[2] - lo[2]).powi(2)).sqrt();
    let mut worst = (0.0f64, 0u32);
    for &node in &slave_set.nodes {
        let x = p.mesh.node(node);
        let (gap, face, s) = nearest(p.mesh, faces, x);
        // The NaN test is not redundant: a degenerate master face makes the projection divide
        // by zero, and `NaN > tol` is false — it would pair silently.
        if gap.is_nan() || gap > tol {
            let c = face_centroid(p.mesh, face);
            return Err(Error::new(
                ErrorCode::ContactUnpaired,
                format!(
                    "contact '{name}': node {node} is {gap} m from set '{master}', more than the tolerance {tol} m; \
                     the nearest master face is centred at [{}, {}, {}]",
                    c[0], c[1], c[2]
                ),
            )
            .at(at())
            .suggest("contact.add with a larger tol, or move the two Bodies until their faces touch"));
        }
        if gap > worst.0 {
            worst = (gap, node);
        }
        let fk = p.mesh.kind_of(face.elem).face_kind();
        let mut w = vec![0.0; fk.n_nodes()];
        face_shape_of(fk, s, &mut w);
        let nodes: Vec<u32> = p.mesh.face_nodes(face).collect();
        // A tie carries translations only: a beam joint bonded to a face is pinned to it.
        for c in 0..dpn.min(3) {
            let masters = nodes
                .iter()
                .zip(&w)
                .filter(|(_, &wi)| wi.abs() > WEIGHT_EPS)
                .map(|(&m, &wi)| (m * dpn as u32 + c as u32, wi))
                .collect();
            out.push(Row { slave: node * dpn as u32 + c as u32, masters, g: 0.0, owner });
        }
    }
    if worst.0 > GAP_WARN * diag {
        warnings.push(Warning {
            code: "contact.gap".into(),
            text: format!(
                "contact '{name}' is not closed: node {} of '{slave}' sits {} m from '{master}' and is tied across \
                 that gap, so the gap carries load as if it were material",
                worst.1, worst.0
            ),
            where_: Some(at()),
        });
    }
    Ok(())
}

/// The rows of one cyclic symmetry tie (plan B §4): every node of `from` is tied to the node it
/// rotates onto in `to`. Node to node, not node to face, because a matching sector mesh from the
/// revolve mesher is the only case in scope, and the pairing is a nearest-node match rather than
/// a projection. `axis` is a coordinate axis (0 = x, 1 = y, 2 = z) and `through` is a point on
/// it; `angle` is in radians.
///
/// A structural DOF mixes its `dpn` components under the rotation `R`; a heat DOF (`dpn == 1`)
/// does not, because a temperature has no orientation to rotate. [`rotation`] returns the right
/// `dpn × dpn` block for either case, so the row loop below never branches on `p.heat`.
// ponytail: O(from nodes × to nodes) scan, same as the bonded pairing above; a bbox grid if a
// tie ever needs more than the few hundred nodes a mesh face at reasonable order-2 density has.
#[allow(clippy::too_many_arguments)]
fn cyclic_rows(
    p: &Problem<'_>,
    name: &str,
    from: &str,
    to: &str,
    axis: usize,
    through: [f64; 3],
    angle: f64,
    tol: f64,
    owner: usize,
    out: &mut Vec<Row>,
) -> Result<(), Error> {
    let at = || format!("cyclic '{name}'");
    let from_nodes = &p.set(from).map_err(|e| e.at(at()))?.nodes;
    let to_set = p.set(to).map_err(|e| e.at(at()))?;
    if let Some(&shared) = from_nodes.iter().find(|n| to_set.nodes.contains(n)) {
        return Err(Error::new(
            ErrorCode::ModelIllPosed,
            format!("cyclic '{name}' ties node {shared} to itself: sets '{from}' and '{to}' share it"),
        )
        .at(at())
        .suggest("constraint.cyclic between the two sector faces of one revolved Body"));
    }
    let dpn = p.dofs_per_node();
    let r = rotation(axis, angle, dpn);
    for &node in from_nodes {
        let xr = rotate_point(p.mesh.node(node), axis, through, angle);
        let mut best = (f64::INFINITY, 0u32);
        for &cand in &to_set.nodes {
            let d = dot3_sub(xr, p.mesh.node(cand));
            if d < best.0 {
                best = (d, cand);
            }
        }
        let gap = best.0.sqrt();
        if gap.is_nan() || gap > tol {
            return Err(Error::new(
                ErrorCode::ContactUnpaired,
                format!(
                    "cyclic '{name}': node {node} of '{from}' rotates to {gap} m from the nearest node of '{to}', \
                     more than the tolerance {tol} m",
                ),
            )
            .at(at())
            .suggest(
                "mesh both sector faces with the revolve mesher, whose theta0/theta1 Sets mesh identically, \
                 or constraint.cyclic with a larger tol",
            ));
        }
        let t = best.1;
        for (c, row) in r.iter().enumerate().take(dpn) {
            let masters: Vec<(u32, f64)> = (0..dpn)
                .filter(|&d| row[d].abs() > WEIGHT_EPS)
                .map(|d| (node * dpn as u32 + d as u32, row[d]))
                .collect();
            out.push(Row { slave: t * dpn as u32 + c as u32, masters, g: 0.0, owner });
        }
    }
    Ok(())
}

/// The rows of one point coupling.
///
/// `distributed` eliminates the point: `u_point = Σ (a_i / A) u_i` over the face's nodes, with
/// `a_i = ∫ N_i dS` the face's own lumped areas and `A` their sum. The point's row of `K` is
/// empty, so `TᵀKT` adds no stiffness anywhere — the face is free to deform exactly as it was —
/// while `Tᵀf` spreads a force at the point over the face in precisely the weights a uniform
/// traction of the same total would assemble, because that traction's consistent nodal force is
/// `t a_i` and this one is `(a_i / A)(t A)`.
///
/// `rigid` is the transpose: every DOF of the face is eliminated onto the point's matching
/// component, so the whole face takes one displacement and cannot deform at all.
///
/// A node carries translations only, so neither kind transmits a moment: there is no rotational
/// DOF at the point to apply one to, and a rigid face translates rather than rotates.
fn couple_rows(
    p: &Problem<'_>,
    name: &str,
    node: u32,
    faces: &str,
    kind: CoupleKind,
    owner: usize,
    out: &mut Vec<Row>,
) -> Result<(), Error> {
    let at = || format!("coupling '{name}'");
    let set = p.set(faces).map_err(|e| e.at(at()))?;
    if set.faces.is_empty() {
        return Err(Error::schema(format!("coupling '{name}' is on set '{faces}', which has no faces"))
            .at(at())
            .suggest("constraint.couple to a face Set, from geometry.nameFace or an auto face"));
    }
    let dpn = p.dofs_per_node() as u32;
    let translations = dpn.min(3);
    match kind {
        CoupleKind::Rigid => {
            for &n in &set.nodes {
                for c in 0..translations {
                    out.push(Row { slave: n * dpn + c, masters: vec![(node * dpn + c, 1.0)], g: 0.0, owner });
                }
            }
        }
        CoupleKind::Distributed => {
            let area = lumped_areas(p, set)?;
            let total: f64 = area.values().sum();
            for c in 0..translations {
                let masters = area.iter().map(|(&n, &a)| (n * dpn + c, a / total)).collect();
                out.push(Row { slave: node * dpn + c, masters, g: 0.0, owner });
            }
        }
    }
    Ok(())
}

/// `dpn × dpn` block of the rotation by `angle` about coordinate axis `axis` (0 = x, 1 = y,
/// 2 = z) that a cyclic tie's DOFs use. A heat Problem's single scalar DOF has no orientation,
/// so `dpn == 1` is the 1×1 identity rather than the top-left corner of the 3×3 matrix — the
/// same code in [`cyclic_rows`] then ties `T_to = T_from` with no branch.
fn rotation(axis: usize, angle: f64, dpn: usize) -> [[f64; 3]; 3] {
    if dpn == 1 {
        return [[1.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]];
    }
    let (c, s) = (libm::cos(angle), libm::sin(angle));
    match axis {
        0 => [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]],
        1 => [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]],
        _ => [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]],
    }
}

/// `x` rotated by `angle` about the line through `through` parallel to coordinate axis `axis`.
fn rotate_point(x: [f64; 3], axis: usize, through: [f64; 3], angle: f64) -> [f64; 3] {
    let d = [x[0] - through[0], x[1] - through[1], x[2] - through[2]];
    let r = rotation(axis, angle, 3);
    let mut out = [0.0; 3];
    for (c, row) in r.iter().enumerate() {
        out[c] = through[c] + dot3(*row, d);
    }
    out
}

/// Squared distance between two points, named for what the caller does with it: find the
/// smallest one without an intervening square root.
fn dot3_sub(a: [f64; 3], b: [f64; 3]) -> f64 {
    let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    dot3(d, d)
}

/// `∫ N_i dS` per node of a face Set: the lumped areas the heat kernel's face integral already
/// produces, so a coupling weights a face exactly as a convection boundary does.
fn lumped_areas(p: &Problem<'_>, set: &ResolvedSet) -> Result<BTreeMap<u32, f64>, Error> {
    let mut area: BTreeMap<u32, f64> = BTreeMap::new();
    let mut coords = Vec::new();
    let mut mat = Vec::new();
    let mut w = Vec::new();
    let mut t = Vec::new();
    for &face in &set.faces {
        let kind = p.mesh.kind_of(face.elem);
        let nn = kind.n_nodes();
        coords.resize(nn * 3, 0.0);
        p.mesh.elem_coords(face.elem, &mut coords);
        t.resize(nn, 0.0);
        p.gather_temperature(face.elem, &mut t);
        mat.clear();
        mat.resize(nn * nn, 0.0);
        w.clear();
        w.resize(nn, 0.0);
        // One `?`: a face integral is pure geometry, so it fails only where the context does.
        p.ctx(face.elem, &coords, &t).and_then(|c| face_integrals(kind, &c, face.local, &mut mat, &mut w))?;
        let conn = p.mesh.elem_nodes(face.elem);
        for &a in kind.face_nodes(face.local as usize) {
            *area.entry(conn[a as usize]).or_insert(0.0) += w[a as usize];
        }
    }
    Ok(area)
}

/// The face of `faces` nearest `x`: its gap, the face, and the face coordinates of the closest
/// point. Ties go to the first face in Set order, which is ascending `(elem, local)`.
fn nearest(mesh: &Mesh, faces: &[Face], x: [f64; 3]) -> (f64, Face, [f64; 2]) {
    let mut best = (f64::INFINITY, faces[0], [0.0, 0.0]);
    for &face in faces {
        let (gap, s) = project(mesh, face, x);
        if gap < best.0 {
            best = (gap, face, s);
        }
    }
    best
}

/// The point of one face closest to `x`, as face coordinates and the distance to it.
///
/// Gauss–Newton on `|X(s) − x|²` from the face centre, with `s` clamped back into the reference
/// face after every step, so a node that projects outside the face lands on its nearest edge or
/// corner rather than on an extrapolation of it.
fn project(mesh: &Mesh, face: Face, x: [f64; 3]) -> (f64, [f64; 2]) {
    let fk = mesh.kind_of(face.elem).face_kind();
    let nn = fk.n_nodes();
    let coords: Vec<[f64; 3]> = mesh.face_nodes(face).map(|n| mesh.node(n)).collect();
    let mut sh = vec![0.0; nn];
    let mut ds = vec![[0.0; 2]; nn];
    let mut s = centre(fk);
    let mut d = [0.0; 3];
    for step in 0..=PROJECT_STEPS {
        face_shape_of(fk, s, &mut sh);
        for (k, dk) in d.iter_mut().enumerate() {
            *dk = coords.iter().zip(&sh).map(|(c, &n)| n * c[k]).sum::<f64>() - x[k];
        }
        if step == PROJECT_STEPS {
            break;
        }
        face_dshape_of(fk, s, &mut ds);
        let mut t = [[0.0; 3]; 2];
        for (c, g) in coords.iter().zip(&ds) {
            for k in 0..3 {
                t[0][k] += g[0] * c[k];
                t[1][k] += g[1] * c[k];
            }
        }
        let (r0, r1) = (-dot3(t[0], d), -dot3(t[1], d));
        if n_par(fk) == 1 {
            s[0] += r0 / dot3(t[0], t[0]);
        } else {
            let (a, b, c) = (dot3(t[0], t[0]), dot3(t[0], t[1]), dot3(t[1], t[1]));
            let det = a * c - b * b;
            s[0] += (c * r0 - b * r1) / det;
            s[1] += (a * r1 - b * r0) / det;
        }
        clamp(fk, &mut s);
    }
    (dot3(d, d).sqrt(), s)
}

fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Free face parameters: two on a quadrilateral or triangle, one on a 2D element's edge.
fn n_par(kind: FaceKind) -> usize {
    match kind {
        FaceKind::Line2 | FaceKind::Line3 => 1,
        _ => 2,
    }
}

/// The centre of the reference face, where the projection starts.
fn centre(kind: FaceKind) -> [f64; 2] {
    match kind {
        FaceKind::Tri3 | FaceKind::Tri6 => [1.0 / 3.0, 1.0 / 3.0],
        _ => [0.0, 0.0],
    }
}

/// `s` moved back into the reference face: the square `[-1, 1]²`, the unit triangle, or the
/// segment `[-1, 1]` of a 2D element's edge.
fn clamp(kind: FaceKind, s: &mut [f64; 2]) {
    match kind {
        FaceKind::Tri3 | FaceKind::Tri6 => {
            s[0] = s[0].max(0.0);
            s[1] = s[1].max(0.0);
            let over = s[0] + s[1] - 1.0;
            if over > 0.0 {
                s[0] = (s[0] - 0.5 * over).max(0.0);
                s[1] = s[1].min(1.0 - s[0]);
            }
        }
        FaceKind::Line2 | FaceKind::Line3 => {
            s[0] = s[0].clamp(-1.0, 1.0);
            s[1] = 0.0;
        }
        _ => {
            s[0] = s[0].clamp(-1.0, 1.0);
            s[1] = s[1].clamp(-1.0, 1.0);
        }
    }
}

/// The centroid of a face, for the `contact.unpaired` message.
fn face_centroid(mesh: &Mesh, face: Face) -> [f64; 3] {
    let mut c = [0.0; 3];
    let mut n = 0.0;
    for node in mesh.face_nodes(face) {
        let x = mesh.node(node);
        for k in 0..3 {
            c[k] += x[k];
        }
        n += 1.0;
    }
    [c[0] / n, c[1] / n, c[2] / n]
}

/// `(TᵀKT, Tᵀ(f − K g))`, built row by row rather than through `assembly::pattern`.
///
/// The transformed operator couples nodes that share no element, so its sparsity is not the
/// element pattern's; building it directly is what lets interface fill-in cost the pattern
/// builder nothing. Slave rows and columns come out empty, and `assembly::reduce` drops them.
///
/// `g` is the inhomogeneous part of the rows, non-zero only for an active frictionless
/// candidate; when every row is homogeneous the load is `Tᵀf` exactly as before, with no
/// arithmetic on it.
///
/// Every row is accumulated in ascending column order under a `BTreeMap`, and the rows are
/// independent, so `vals` is bit-identical at one and at N threads.
// ponytail: a BTreeMap per row, O(interface²) fill; a dense scratch plus a touched list only if
// the interface ever dominates assembly time.
pub fn transform(k: &Csr, f: &[f64], mpc: &Mpc) -> (Csr, Vec<f64>) {
    if mpc.is_empty() {
        return (k.clone(), f.to_vec());
    }
    let load: Vec<f64> = if mpc.inhomogeneous() {
        let mut g = vec![0.0; k.n];
        for row in &mpc.rows {
            g[row.slave as usize] = row.g;
        }
        let mut kg = vec![0.0; k.n];
        k.spmv(&g, &mut kg);
        f.iter().zip(&kg).map(|(a, b)| a - b).collect()
    } else {
        f.to_vec()
    };
    let mut reverse: BTreeMap<u32, Vec<(u32, f64)>> = BTreeMap::new();
    for row in &mpc.rows {
        for &(m, a) in &row.masters {
            reverse.entry(m).or_default().push((row.slave, a));
        }
    }
    let none: Vec<(u32, f64)> = Vec::new();
    let built: Vec<(Vec<u32>, Vec<f64>)> = par::map_collect(k.n, |r| {
        if mpc.row_of(r as u32).is_some() {
            return (Vec::new(), Vec::new());
        }
        let mut acc: BTreeMap<u32, f64> = BTreeMap::new();
        add_row(k, mpc, r as u32, 1.0, &mut acc);
        for &(s, a) in reverse.get(&(r as u32)).unwrap_or(&none) {
            add_row(k, mpc, s, a, &mut acc);
        }
        acc.into_iter().unzip()
    });
    let mut row_ptr = vec![0u32; k.n + 1];
    let mut col_idx = Vec::with_capacity(k.nnz());
    let mut vals = Vec::with_capacity(k.nnz());
    for (r, (cols, v)) in built.into_iter().enumerate() {
        col_idx.extend_from_slice(&cols);
        vals.extend_from_slice(&v);
        row_ptr[r + 1] = col_idx.len() as u32;
    }
    (Csr { n: k.n, row_ptr, col_idx, vals }, transpose_load(mpc, &load))
}

/// `Tᵀf`: the slave entries emptied and each one added into its masters. The right-hand side
/// half of [`transform`], on its own for a caller that has a second load vector to move but the
/// same operator — the amplitude schedule of a static Step transforms its thermal load this way.
pub fn transpose_load(mpc: &Mpc, f: &[f64]) -> Vec<f64> {
    let mut out = f.to_vec();
    for &s in &mpc.slaves {
        out[s as usize] = 0.0;
    }
    // A master is never a slave, so zeroing above cannot swallow what this adds.
    master_forces(mpc, f, &mut out);
    out
}

/// `acc += scale · (row `i` of `K`) · T`: an entry in a slave column is distributed over that
/// slave's masters, everything else lands where it is.
fn add_row(k: &Csr, mpc: &Mpc, i: u32, scale: f64, acc: &mut BTreeMap<u32, f64>) {
    for e in k.row_ptr[i as usize] as usize..k.row_ptr[i as usize + 1] as usize {
        let (j, v) = (k.col_idx[e], k.vals[e]);
        match mpc.row_of(j) {
            Some(row) => {
                for &(m, b) in &row.masters {
                    *acc.entry(m).or_insert(0.0) += scale * v * b;
                }
            }
            None => *acc.entry(j).or_insert(0.0) += scale * v,
        }
    }
}

/// Put the eliminated DOFs back: `u[slave] = Σ a·u[master] + g`.
///
/// One pass is exact because a master is never itself a slave — [`build`] refuses a chain.
/// `g` is added only where it is non-zero, so a homogeneous row's value is the bare sum it
/// always was, sign of zero included.
pub fn recover(mpc: &Mpc, u: &mut [f64]) {
    for row in &mpc.rows {
        let v: f64 = row.masters.iter().map(|&(m, a)| a * u[m as usize]).sum();
        u[row.slave as usize] = if row.g != 0.0 { v + row.g } else { v };
    }
}

/// Add the tie force each constraint carries into its masters, given the residual
/// `r = K u − f` of the **original** system.
///
/// A slave row of the untransformed system is not in equilibrium on its own: `r[slave]` is the
/// force the tie applies there, and by action and reaction the tie pushes `a · r[slave]` into
/// each master. A support that holds a master DOF therefore carries `r[dof]` *plus* that, which
/// is what [`crate::fem::assembly::reactions`] adds through this function. Nothing is written
/// at a free DOF: there the same identity is the equilibrium the solve enforced.
pub fn master_forces(mpc: &Mpc, r: &[f64], out: &mut [f64]) {
    for row in &mpc.rows {
        for &(m, a) in &row.masters {
            out[m as usize] += a * r[row.slave as usize];
        }
    }
}
