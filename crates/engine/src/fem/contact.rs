//! Frictionless contact by an active set of eliminated normal constraints (#62, plan 6.5).
//!
//! A frictionless pair is a set of *candidates*: slave nodes [`mpc::build`] paired with the
//! master surface at the reference configuration (small sliding). Each one is either **active**
//! — held on the master surface by the inhomogeneous row `(u_s − Σ a·u_m)·n = −g₀`, eliminated
//! exactly as a bonded tie is (no penalty, ADR 0002) — or **inactive**, free. The rule that
//! moves a node between the two is the Signorini condition read off the solved state: an active
//! node whose normal force has turned tensile is released, an inactive node whose gap has gone
//! negative is held. A solve repeats until no node moves; the linear `static` procedure repeats
//! whole linear solves (what Nastran calls linear contact), `static-nonlinear` repeats its
//! Newton iteration. Tangential motion is never constrained, so a held node slides freely along
//! the (fixed) master face.
//!
//! The normal force an active node carries is read from the residual of the **original**
//! system: at the eliminated DOF `k` the solved system enforces nothing, so `r_k = (K u − f)_k`
//! (or `(f_int − λ f_ext)_k`) is the constraint force there, and since the row also makes the
//! slave's other components masters of `k`, that force is along `n` by construction —
//! `λ = r_k / n_k` is its magnitude, positive in compression.
//!
//! [`pressure`] turns those nodal forces into a nodal pressure by an L2 projection on the slave
//! faces, `M p = λ` with `M = ∫ Nᵀ N dS`, rather than by dividing by a lumped area: a quadratic
//! face has lumped areas that vanish (a quad8's corner on the axis of an axisymmetric Model has
//! `∫ N₀ 2πr ds = 0`), and the projection is exact for a pressure the face can represent.

use std::collections::BTreeMap;

use crate::error::{Error, ErrorCode, Warning};
use crate::fem::assembly::Csr;
use crate::fem::heat::face_integrals;
use crate::fem::mpc::Mpc;
use crate::fem::problem::{Coupling, Problem};
use crate::post::{FieldData, Per};
use crate::procedure::ContactSummary;
use crate::solve::direct::Direct;
use crate::solve::LinearSolve;

/// How many times one node may join or leave the set in one solve before that is chatter.
pub const MAX_FLIPS: u32 = 8;
/// A normal force below `−FORCE_TOL · scale` is tensile. `scale` is the largest force in the
/// residual plus the largest stiffness times the largest displacement — the second term is
/// what a rounding error in `K u` is worth as a force, and keeps a state with no force in it at
/// all (a part sliding freely along the master) from releasing nodes on noise.
const FORCE_TOL: f64 = 1e-9;

/// Which candidates are held, and how often each has changed its mind.
#[derive(Debug, Clone, PartialEq)]
pub struct ActiveSet {
    /// Parallel to [`Mpc::candidates`].
    pub active: Vec<bool>,
    flips: Vec<u32>,
    /// Passes of [`ActiveSet::update`] that moved at least one node, over the whole Step.
    pub changes: usize,
}

impl ActiveSet {
    /// The starting set: every candidate whose initial gap is closed (within the pairing's own
    /// rounding) is held, every one that starts open is free.
    pub fn initial(mpc: &Mpc) -> ActiveSet {
        let active: Vec<bool> = mpc.candidates.iter().map(|c| c.gap <= mpc.gap_tol).collect();
        ActiveSet { flips: vec![0; active.len()], active, changes: 0 }
    }

    /// A Problem without a frictionless pair has nothing to update.
    pub fn is_empty(&self) -> bool {
        self.active.is_empty()
    }

    /// How many candidates are held.
    pub fn count(&self) -> usize {
        self.active.iter().filter(|a| **a).count()
    }

    /// The normal force each candidate carries, positive in compression: `r_k / n_k` at an
    /// active node's eliminated DOF, zero at an inactive one. `residual` is `K u − f` (or
    /// `f_int − λ f_ext`) of the original, untransformed system.
    pub fn forces(&self, mpc: &Mpc, residual: &[f64], dpn: usize) -> Vec<f64> {
        mpc.candidates
            .iter()
            .zip(&self.active)
            .map(|(c, &on)| if on { residual[c.slave_dof(dpn) as usize] / c.normal[c.comp] } else { 0.0 })
            .collect()
    }

    /// One pass of the rule: release every held node whose normal force is tensile, hold every
    /// free node whose gap has closed. `true` when something moved. `stiffness` is the largest
    /// diagonal of the operator, which sets the force a rounding error in `u` is worth. A node
    /// that has moved more than [`MAX_FLIPS`] times is `contact.chatter`, naming it.
    pub fn update(
        &mut self,
        p: &Problem<'_>,
        mpc: &Mpc,
        u: &[f64],
        residual: &[f64],
        stiffness: f64,
    ) -> Result<bool, Error> {
        let dpn = p.dofs_per_node();
        let largest = |v: &[f64]| v.iter().fold(0.0f64, |m, x| m.max(x.abs()));
        let scale = largest(residual) + stiffness * largest(u);
        let forces = self.forces(mpc, residual, dpn);
        let mut moved = false;
        for (i, c) in mpc.candidates.iter().enumerate() {
            let flip = if self.active[i] {
                forces[i] < -FORCE_TOL * scale
            } else {
                c.gap + c.relative_normal(u, dpn) < -mpc.gap_tol
            };
            if flip {
                self.active[i] = !self.active[i];
                self.flips[i] += 1;
                moved = true;
            }
        }
        if moved {
            self.changes += 1;
        }
        let chattering: Vec<usize> = (0..self.flips.len()).filter(|&i| self.flips[i] > MAX_FLIPS).collect();
        if let Some(&first) = chattering.first() {
            let owner = mpc.candidates[first].owner;
            let nodes: Vec<String> = chattering.iter().map(|&i| mpc.candidates[i].node.to_string()).collect();
            return Err(Error::new(
                ErrorCode::ContactChatter,
                format!(
                    "contact '{}': node{} {} keep{} joining and leaving the active set (more than {MAX_FLIPS} times), so \
                     the contact state does not settle",
                    p.couplings[owner].name(),
                    if nodes.len() == 1 { "" } else { "s" },
                    nodes.join(", "),
                    if nodes.len() == 1 { "s" } else { "" },
                ),
            )
            .at(format!("contact '{}'", p.couplings[owner].name()))
            .suggest("step.add with an amplitude of more increments so the load is applied gradually, or mesh.set finer where the contact edge lands"));
        }
        Ok(moved)
    }
}

/// `K u − f`: the residual of the original system, whose slave entries are the contact forces.
pub fn residual(k: &Csr, u: &[f64], f: &[f64]) -> Vec<f64> {
    let mut r = vec![0.0; k.n];
    k.spmv(u, &mut r);
    for (v, fi) in r.iter_mut().zip(f) {
        *v -= fi;
    }
    r
}

/// `contact.open`: the reduced system lost positive definiteness while a pair was partly or
/// fully open, which is a part that nothing but the contact was holding and that has lifted off.
pub fn lifted_off(p: &Problem<'_>, mpc: &Mpc, set: &ActiveSet) -> Error {
    let open: Vec<String> = p
        .couplings
        .iter()
        .enumerate()
        .filter(|(_, c)| c.is_frictionless())
        .map(|(i, c)| {
            let paired = mpc.candidates.iter().filter(|k| k.owner == i).count();
            let held = mpc.candidates.iter().zip(&set.active).filter(|(k, &on)| k.owner == i && on).count();
            format!("'{}' holds {held} of {paired} paired nodes", c.name())
        })
        .collect();
    Error::new(
        ErrorCode::ContactOpen,
        format!(
            "a part is held only by a frictionless contact that has opened, so it can move freely: {}",
            open.join("; ")
        ),
    )
    .at("constraints")
    .suggest("constraint.fix a Set that holds the part against the motions the contact cannot stop, or load it so the faces stay pressed together")
}

/// The contact pressure on the slave nodes of every frictionless pair, by an L2 projection of
/// the nodal normal forces onto the slave faces, and zero on every other node. `forces` is
/// [`ActiveSet::forces`].
fn pressure(p: &Problem<'_>, mpc: &Mpc, forces: &[f64]) -> FieldData {
    let mut field = vec![0.0; p.mesh.n_nodes()];
    let mut coords = Vec::new();
    let mut mat = Vec::new();
    let mut w = Vec::new();
    let mut t = Vec::new();
    for (owner, c) in p.couplings.iter().enumerate() {
        let Coupling::Frictionless { slave, .. } = c else { continue };
        let set = p.set(slave).expect("build paired this Set");
        let local: BTreeMap<u32, usize> = set.nodes.iter().enumerate().map(|(i, &n)| (n, i)).collect();
        let n = local.len();
        let mut entries: BTreeMap<(u32, u32), f64> = BTreeMap::new();
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
            let ctx = p.ctx(face.elem, &coords, &t).expect("the checks accepted this element's material");
            face_integrals(kind, &ctx, face.local, &mut mat, &mut w).expect("the checks accepted this face");
            let conn = p.mesh.elem_nodes(face.elem);
            for &a in kind.face_nodes(face.local as usize) {
                for &b in kind.face_nodes(face.local as usize) {
                    let (i, j) = (local[&conn[a as usize]] as u32, local[&conn[b as usize]] as u32);
                    *entries.entry((i, j)).or_insert(0.0) += mat[a as usize * nn + b as usize];
                }
            }
        }
        let mut row_ptr = vec![0u32; n + 1];
        let mut col_idx = Vec::with_capacity(entries.len());
        let mut vals = Vec::with_capacity(entries.len());
        for (&(i, j), &v) in &entries {
            col_idx.push(j);
            vals.push(v);
            row_ptr[i as usize + 1] = col_idx.len() as u32;
        }
        let m = Csr { n, row_ptr, col_idx, vals };
        let mut rhs = vec![0.0; n];
        for (cand, &f) in mpc.candidates.iter().zip(forces).filter(|(k, _)| k.owner == owner) {
            rhs[local[&cand.node]] = f;
        }
        let mut x = vec![0.0; n];
        // A face mass matrix is positive definite for any face the checks let through, and the
        // right-hand side is a handful of nodal forces, so neither the factorisation nor the
        // residual check can fail here.
        let mut factored = Direct::factor(&m).expect("a face mass matrix is positive definite");
        factored.solve(&rhs, &mut x).expect("a face mass matrix is well conditioned");
        for (&node, &i) in &local {
            field[node as usize] = x[i];
        }
    }
    FieldData::new(Per::Node, 1, field)
}

/// What a solved Step reports for its frictionless pairs: the `contactPressure` field, one
/// summary per pair in coupling order, and a `contact.open` warning for every pair that ended
/// with no node held. `residual` is the original system's, as for [`ActiveSet::forces`].
pub fn finish(
    p: &Problem<'_>,
    mpc: &Mpc,
    set: &ActiveSet,
    residual: &[f64],
    warnings: &mut Vec<Warning>,
) -> (FieldData, Vec<ContactSummary>) {
    let dpn = p.dofs_per_node();
    let forces = set.forces(mpc, residual, dpn);
    let mut summaries = Vec::new();
    for (owner, c) in p.couplings.iter().enumerate() {
        let Coupling::Frictionless { name, master, slave, .. } = c else { continue };
        let mut force = [0.0; 3];
        let (mut active, mut paired) = (0, 0);
        for (i, cand) in mpc.candidates.iter().enumerate().filter(|(_, k)| k.owner == owner) {
            paired += 1;
            active += usize::from(set.active[i]);
            for k in 0..3 {
                force[k] += forces[i] * cand.normal[k];
            }
        }
        if active == 0 {
            warnings.push(Warning {
                code: "contact.open".into(),
                text: format!(
                    "contact '{name}' ended fully open: none of the {paired} paired nodes of '{slave}' touches \
                     '{master}', so the two parts do not interact in this Step"
                ),
                where_: Some(format!("contact '{name}'")),
            });
        }
        summaries.push(ContactSummary { name: name.clone(), active, paired, force });
    }
    (pressure(p, mpc, &forces), summaries)
}
