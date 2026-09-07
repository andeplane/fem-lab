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
//! Only homogeneous relations are built: every constraint in scope (bonded contact, and the
//! couplings and cyclic symmetry that come later) is `u_s − Σ a u_m = 0`, so there is no
//! `Tᵀ(f − Kg)` branch and no arm no test can reach.
//!
//! [`build`] is a pure function of the [`Problem`] and its Mesh with no cached state, because
//! frictionless contact will call it inside a Newton loop where the active set changes between
//! iterations.

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

/// One eliminated DOF: `u[slave] = Σ coeff · u[master]`. Homogeneous by construction.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub slave: u32,
    pub masters: Vec<(u32, f64)>,
    /// Index into [`Problem::couplings`], so every error and warning names its Command.
    pub owner: usize,
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
    let mut warnings: Vec<Warning> = Vec::new();
    for (owner, c) in p.couplings.iter().enumerate() {
        let mut produced: Vec<Row> = Vec::new();
        match c {
            Coupling::Bonded { name, master, slave, tol } => {
                bonded_rows(p, name, master, slave, *tol, owner, &mut produced, &mut warnings)?;
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
    let dpn = p.dofs_per_node();
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
    Ok(Mpc { rows, slaves, contact, warnings })
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
        for c in 0..dpn {
            let masters = nodes
                .iter()
                .zip(&w)
                .filter(|(_, &wi)| wi.abs() > WEIGHT_EPS)
                .map(|(&m, &wi)| (m * dpn as u32 + c as u32, wi))
                .collect();
            out.push(Row { slave: node * dpn as u32 + c as u32, masters, owner });
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
    match kind {
        CoupleKind::Rigid => {
            for &n in &set.nodes {
                for c in 0..dpn {
                    out.push(Row { slave: n * dpn + c, masters: vec![(node * dpn + c, 1.0)], owner });
                }
            }
        }
        CoupleKind::Distributed => {
            let area = lumped_areas(p, set)?;
            let total: f64 = area.values().sum();
            for c in 0..dpn {
                let masters = area.iter().map(|(&n, &a)| (n * dpn + c, a / total)).collect();
                out.push(Row { slave: node * dpn + c, masters, owner });
            }
        }
    }
    Ok(())
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

/// `(TᵀKT, Tᵀf)`, built row by row rather than through `assembly::pattern`.
///
/// The transformed operator couples nodes that share no element, so its sparsity is not the
/// element pattern's; building it directly is what lets interface fill-in cost the pattern
/// builder nothing. Slave rows and columns come out empty, and `assembly::reduce` drops them.
///
/// Every row is accumulated in ascending column order under a `BTreeMap`, and the rows are
/// independent, so `vals` is bit-identical at one and at N threads.
// ponytail: a BTreeMap per row, O(interface²) fill; a dense scratch plus a touched list only if
// the interface ever dominates assembly time.
pub fn transform(k: &Csr, f: &[f64], mpc: &Mpc) -> (Csr, Vec<f64>) {
    if mpc.is_empty() {
        return (k.clone(), f.to_vec());
    }
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
    (Csr { n: k.n, row_ptr, col_idx, vals }, transpose_load(mpc, f))
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

/// Put the eliminated DOFs back: `u[slave] = Σ a·u[master]`.
///
/// One pass is exact because a master is never itself a slave — [`build`] refuses a chain.
pub fn recover(mpc: &Mpc, u: &mut [f64]) {
    for row in &mpc.rows {
        u[row.slave as usize] = row.masters.iter().map(|&(m, a)| a * u[m as usize]).sum();
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
