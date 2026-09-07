//! Sparse assembly: one CSR, one slot map, and a deterministic chunked scatter (plan A §4).
//!
//! There is a single sparse format, CSR with both triangles and `u32` indices. It is what the
//! GPU SpMV wants, and a symmetric CSR *is* its own CSC, so faer factorises the very same
//! arrays with no copy ([`Csr::as_faer`]).
//!
//! Determinism is by construction, not by luck. The sparsity pattern and the `slot` map are
//! built once from the Mesh; assembly then walks the elements in chunks, computes every `K_e`
//! of a chunk in parallel into a buffer (no shared writes), and adds them into `vals`
//! sequentially in ascending element order. The addition order per non-zero is therefore
//! "ascending element id" whatever the thread count, and `vals` is bit-identical at 1 and N
//! threads. Chunk sizes are functions of the element size alone; `rayon::current_num_threads`
//! is never read.

use femlab_geometry::Mesh;

use crate::error::{Error, ErrorCode};
use crate::fem::element::{element_for, TangentOut};
use crate::fem::material::VOIGT;
use crate::fem::problem::{local_dofs, Problem};
use crate::fem::state::GpState;
use crate::par;
use crate::post::{FieldData, Per};

/// Rows per parallel chunk in [`Csr::spmv`]. A constant, so the partition never depends on the
/// thread count (each row is summed sequentially anyway, so this only bounds task size).
const SPMV_CHUNK: usize = 1024;
/// Bytes of element-matrix buffer one assembly chunk may hold; the chunk length follows from
/// it and the element size, never from the number of threads (plan A R8).
const CHUNK_BYTES: usize = 32 << 20;
/// Upper bound on the elements in one chunk (plan A §4).
const MAX_CHUNK: usize = 2048;

/// Elements per assembly chunk for an element with `n_dof` degrees of freedom.
fn chunk_elems(n_dof: usize) -> usize {
    (CHUNK_BYTES / (n_dof * n_dof * 8)).clamp(1, MAX_CHUNK)
}

/// A square sparse matrix in CSR with both triangles stored. Rows are sorted by column.
#[derive(Debug, Clone, PartialEq)]
pub struct Csr {
    pub n: usize,
    /// `n + 1` offsets into `col_idx` / `vals`.
    pub row_ptr: Vec<u32>,
    pub col_idx: Vec<u32>,
    pub vals: Vec<f64>,
}

impl Csr {
    pub fn nnz(&self) -> usize {
        self.col_idx.len()
    }

    /// `y = A x`, parallel over row chunks and sequential inside a row, so the sum of each row
    /// is in ascending column order at any thread count.
    pub fn spmv(&self, x: &[f64], y: &mut [f64]) {
        par::for_each_chunk_mut(y, SPMV_CHUNK, |c, rows| {
            for (i, yi) in rows.iter_mut().enumerate() {
                let r = c * SPMV_CHUNK + i;
                let mut s = 0.0;
                for k in self.row_ptr[r] as usize..self.row_ptr[r + 1] as usize {
                    s += self.vals[k] * x[self.col_idx[k] as usize];
                }
                *yi = s;
            }
        });
    }

    /// The main diagonal; zero where a row has no diagonal entry (which a pattern from
    /// [`pattern`] never has).
    pub fn diag(&self) -> Vec<f64> {
        (0..self.n)
            .map(|r| {
                let (lo, hi) = (self.row_ptr[r] as usize, self.row_ptr[r + 1] as usize);
                match self.col_idx[lo..hi].binary_search(&(r as u32)) {
                    Ok(i) => self.vals[lo + i],
                    Err(_) => 0.0,
                }
            })
            .collect()
    }

    /// Add `v` at `(row, col)`, an entry [`pattern_coupled`] promised is there. A thermal
    /// contact adds directly into `K` rather than eliminating a row, so it needs a named entry
    /// rather than the element scatter's slot map, which only ever names entries an element
    /// contributed.
    pub fn add_at(&mut self, row: u32, col: u32, v: f64) {
        let (lo, hi) = (self.row_ptr[row as usize] as usize, self.row_ptr[row as usize + 1] as usize);
        let at = self.col_idx[lo..hi].binary_search(&col).expect("pattern_coupled seeded this entry");
        self.vals[lo + at] += v;
    }

    /// The same arrays as a faer sparse matrix. A symmetric matrix stored row-major in CSR is
    /// the identical byte layout as its own column-major CSC, so faer reads our arrays in
    /// place; only the lower triangle is looked at (`Side::Lower`) by the Cholesky.
    pub fn as_faer(&self) -> faer::sparse::SparseColMatRef<'_, u32, f64> {
        let symbolic =
            faer::sparse::SymbolicSparseColMatRef::new_checked(self.n, self.n, &self.row_ptr, None, &self.col_idx);
        faer::sparse::SparseColMatRef::new(symbolic, &self.vals)
    }
}

/// A sparsity pattern plus the map from element matrix entries to positions in `csr.vals`.
///
/// `slot[slot_ptr[e] + i * n_dof + j]` is the index into `vals` of entry `(i, j)` of element
/// `e`'s matrix, so the scatter is one indexed add per entry and needs no search.
#[derive(Debug, Clone, PartialEq)]
pub struct Pattern {
    /// `vals` zeroed; every assembly starts from a clone of it.
    pub csr: Csr,
    pub slot: Vec<u32>,
    /// `n_elems + 1` offsets into `slot`; elements differ in `n_dof` between blocks.
    pub slot_ptr: Vec<u32>,
}

/// Copy one element's DOFs out of a global vector: the element's own stride `ldpn` per node
/// ([`local_dofs`]) from the global stride `dpn`. The two differ only for a solid or a truss
/// in a six-DOF (beam) Problem, whose rotational slots the element never reads.
pub(crate) fn gather(u: &[f64], nodes: &[u32], ldpn: usize, dpn: usize, out: &mut [f64]) {
    for (a, &node) in nodes.iter().enumerate() {
        let at = node as usize * dpn;
        out[a * ldpn..(a + 1) * ldpn].copy_from_slice(&u[at..at + ldpn]);
    }
}

/// Add one element's vector into the global one, the inverse of [`gather`].
pub(crate) fn scatter_add(fe: &[f64], nodes: &[u32], ldpn: usize, dpn: usize, f: &mut [f64]) {
    for (a, &node) in nodes.iter().enumerate() {
        for c in 0..ldpn {
            f[node as usize * dpn + c] += fe[a * ldpn + c];
        }
    }
}

/// The sparsity of `K` for `dofs_per_node` unknowns per node, and the slot map into it.
///
/// Two nodes are coupled when they share an element, so the pattern is the node adjacency
/// blown up by `dofs_per_node`; rows come out sorted because the neighbour lists are. An
/// element's slot map covers its own [`local_dofs`] per node, so in a six-DOF Problem a solid's
/// rotational rows are seeded (every node owns a full diagonal block) but never written to.
pub fn pattern(mesh: &Mesh, dofs_per_node: usize) -> Pattern {
    pattern_coupled(mesh, dofs_per_node, &[])
}

/// The pattern of [`pattern`] with extra node pairs merged into the neighbour lists.
///
/// Some entries of the assembled operator are created by neither an element nor the
/// eliminations of `mpc::transform`, which builds its own sparsity: a thermal contact
/// resistance couples the two sides of a tie directly in the operator. `extra` is the
/// `[a, b]` node pairs that need room, in either order; both triangles are seeded.
///
/// Every node also seeds its own neighbour list, so a node that no element touches still owns
/// a diagonal entry and `Csr::diag` is never zero by absence.
pub fn pattern_coupled(mesh: &Mesh, dofs_per_node: usize, extra: &[[u32; 2]]) -> Pattern {
    let n_nodes = mesh.n_nodes();
    let adj = mesh.node_to_elems();
    let mut added: Vec<Vec<u32>> = vec![Vec::new(); n_nodes];
    for &[a, b] in extra {
        added[a as usize].push(b);
        added[b as usize].push(a);
    }
    // Neighbour nodes of every node, sorted and unique, always including the node itself.
    let neighbours: Vec<Vec<u32>> = par::map_collect(n_nodes, |n| {
        let mut v: Vec<u32> = adj.of(n).iter().flat_map(|&e| mesh.elem_nodes(e).iter().copied()).collect();
        v.push(n as u32);
        v.extend_from_slice(&added[n]);
        v.sort_unstable();
        v.dedup();
        v
    });
    let n = n_nodes * dofs_per_node;
    let mut row_ptr = vec![0u32; n + 1];
    for (i, nb) in neighbours.iter().enumerate() {
        let len = (nb.len() * dofs_per_node) as u32;
        for c in 0..dofs_per_node {
            row_ptr[i * dofs_per_node + c + 1] = len;
        }
    }
    for r in 0..n {
        row_ptr[r + 1] += row_ptr[r];
    }
    let mut col_idx = vec![0u32; row_ptr[n] as usize];
    for i in 0..n_nodes {
        let row = &neighbours[i];
        for c in 0..dofs_per_node {
            let lo = row_ptr[i * dofs_per_node + c] as usize;
            for (k, &m) in row.iter().enumerate() {
                for c2 in 0..dofs_per_node {
                    col_idx[lo + k * dofs_per_node + c2] = m * dofs_per_node as u32 + c2 as u32;
                }
            }
        }
    }

    let mut slot_ptr = vec![0u32; mesh.n_elems() + 1];
    for e in 0..mesh.n_elems() as u32 {
        let kind = mesh.kind_of(e);
        let nd = (kind.n_nodes() * local_dofs(kind, dofs_per_node)) as u32;
        slot_ptr[e as usize + 1] = slot_ptr[e as usize] + nd * nd;
    }
    let mut slot = vec![0u32; *slot_ptr.last().expect("n_elems + 1 entries") as usize];
    for blk in &mesh.blocks {
        let ldpn = local_dofs(blk.kind, dofs_per_node);
        let nd = blk.kind.n_nodes() * ldpn;
        let lo = slot_ptr[blk.first_elem as usize] as usize;
        let part = &mut slot[lo..lo + blk.n_elems() * nd * nd];
        par::for_each_chunk_mut(part, nd * nd, |i, out| {
            let conn = &blk.conn[i * blk.kind.n_nodes()..(i + 1) * blk.kind.n_nodes()];
            for (a, &na) in conn.iter().enumerate() {
                for ca in 0..ldpn {
                    let row = na as usize * dofs_per_node + ca;
                    let (rlo, rhi) = (row_ptr[row] as usize, row_ptr[row + 1] as usize);
                    let cols = &col_idx[rlo..rhi];
                    for (b, &nb) in conn.iter().enumerate() {
                        for cb in 0..ldpn {
                            let col = (nb as usize * dofs_per_node + cb) as u32;
                            let at = cols.binary_search(&col).expect("the pattern holds every element coupling");
                            out[(a * ldpn + ca) * nd + b * ldpn + cb] = (rlo + at) as u32;
                        }
                    }
                }
            }
        });
    }
    let vals = vec![0.0; col_idx.len()];
    Pattern { csr: Csr { n, row_ptr, col_idx, vals }, slot, slot_ptr }
}

/// The assembled operator, the vector that went with it, and the worst Jacobian seen.
///
/// The linear arm fills `f_thermal`; the finite-strain arm fills `f_int`, `stress_gp`,
/// `strain_gp` and `state` and leaves `f_thermal` empty, because thermal strain is subtracted
/// inside the element there and is therefore already part of the internal force.
#[derive(Debug, Clone, PartialEq)]
pub struct Assembled {
    pub k: Csr,
    /// `∫ Bᵀ D α ΔT dV` per DOF; all zeros when the Problem has no temperature field, and
    /// empty on the finite-strain arm.
    pub f_thermal: Vec<f64>,
    /// `∫ B_Lᵀ S dV` per DOF: the internal force at the trial displacement. Empty on the
    /// linear arm, where the internal force is `K u` by definition.
    pub f_int: Vec<f64>,
    /// Cauchy stress at every Gauss point, elements in order; empty on the linear arm.
    pub stress_gp: FieldData,
    /// Green–Lagrange strain at every Gauss point, elements in order; empty on the linear arm.
    pub strain_gp: FieldData,
    /// The per-Gauss-point state the elements advanced to; empty on the linear arm.
    pub state: GpState,
    /// The smallest Gauss-point `det J` over the mesh, reported as a Result scalar.
    pub min_det_j: f64,
}

/// What a finite-strain assembly integrates at: the total displacement and the last converged
/// Gauss-point state. `None` in [`assemble_tangent`] is the linear arm and is what
/// [`assemble_stiffness`] passes.
pub struct NlInput<'a> {
    /// Total nodal displacement, in the Problem's DOF numbering.
    pub u: &'a [f64],
    /// The last converged state, which every trial evaluation reads and none writes.
    pub state: &'a GpState,
}

/// One element's contribution, computed in parallel and scattered sequentially.
struct ElemOut {
    ke: Vec<f64>,
    fe: Vec<f64>,
    stress: Vec<f64>,
    strain: Vec<f64>,
    state: Vec<f64>,
    det: f64,
}

/// `K` (and the thermal load) for a linear-elastic Problem, into a fresh copy of `pat.csr`.
///
/// The linear arm of [`assemble_tangent`], unchanged in every bit: same integrals, same chunk
/// boundaries, same scatter order.
pub fn assemble_stiffness(p: &Problem<'_>, pat: &Pattern) -> Result<Assembled, Error> {
    assemble_tangent(p, pat, None)
}

/// The assembled operator for a Problem, linear (`nl = None`) or finite-strain.
///
/// Elements are integrated in parallel within a chunk and scattered sequentially in element
/// order, which is what makes the result bit-identical at any thread count (module docs).
/// There is exactly one copy of that loop, and both arms go through it, so the linear path
/// cannot drift away from the nonlinear one — or from itself.
///
/// The linear arm calls [`Element::stiffness`](crate::fem::element::Element::stiffness) and
/// [`Element::thermal_load`](crate::fem::element::Element::thermal_load); the finite-strain arm
/// calls [`Element::tangent_and_force`](crate::fem::element::Element::tangent_and_force) at
/// `nl.u`, which also advances the per-point state and recovers the Gauss-point fields, so a
/// Newton iteration is one pass over the mesh rather than three.
pub fn assemble_tangent(p: &Problem<'_>, pat: &Pattern, nl: Option<NlInput<'_>>) -> Result<Assembled, Error> {
    let dpn = p.dofs_per_node();
    let mut k = pat.csr.clone();
    let mut f_out = vec![0.0; p.n_dofs()];
    let mut min_det_j = f64::INFINITY;
    let thermal = p.temperature.is_some();
    let mut state = nl.as_ref().map(|_| GpState::new(p)).transpose()?;
    let (mut stress, mut strain) = (Vec::new(), Vec::new());
    for blk in &p.mesh.blocks {
        let element = element_for(blk.kind);
        let ldpn = p.node_dofs(blk.kind);
        let (nn, nd) = (blk.kind.n_nodes(), blk.kind.n_nodes() * ldpn);
        let n_gp = element.n_gp();
        let step = chunk_elems(nd);
        for lo in (0..blk.n_elems()).step_by(step) {
            let hi = (lo + step).min(blk.n_elems());
            let parts = par::map_collect(hi - lo, |i| {
                let elem = blk.first_elem + (lo + i) as u32;
                let mut coords = vec![0.0; nn * 3];
                p.mesh.elem_coords(elem, &mut coords);
                let mut t = vec![0.0; nn];
                p.gather_temperature(elem, &mut t);
                let c = p.ctx(elem, &coords, &t)?;
                let mut e = ElemOut {
                    ke: vec![0.0; nd * nd],
                    fe: vec![0.0; nd],
                    stress: Vec::new(),
                    strain: Vec::new(),
                    state: Vec::new(),
                    det: 0.0,
                };
                e.det = match &nl {
                    // One `?`: the stiffness and the thermal load fail on exactly the same
                    // elements and materials, so a second one would be an untestable arm.
                    None => element.stiffness(&c, &mut e.ke).and_then(|det| {
                        if thermal {
                            element.thermal_load(&c, &mut e.fe).map(|()| det)
                        } else {
                            Ok(det)
                        }
                    }),
                    Some(nl) => {
                        let mut ue = vec![0.0; nd];
                        gather(nl.u, p.mesh.elem_nodes(elem), ldpn, dpn, &mut ue);
                        e.stress = vec![0.0; n_gp * VOIGT];
                        e.strain = vec![0.0; n_gp * VOIGT];
                        e.state = vec![0.0; n_gp * c.material.law.n_state()];
                        let out = TangentOut {
                            k: &mut e.ke,
                            f: &mut e.fe,
                            stress: &mut e.stress,
                            strain: &mut e.strain,
                            state: &mut e.state,
                        };
                        element.tangent_and_force(&c, &ue, nl.state.of(elem), out)
                    }
                }
                .map_err(|err| err.at(format!("element {elem}")))?;
                Ok::<_, Error>(e)
            });
            for (i, part) in parts.into_iter().enumerate() {
                let e = part?;
                let elem = blk.first_elem + (lo + i) as u32;
                min_det_j = min_det_j.min(e.det);
                let slot = &pat.slot[pat.slot_ptr[elem as usize] as usize..pat.slot_ptr[elem as usize + 1] as usize];
                for (s, v) in slot.iter().zip(e.ke.iter()) {
                    k.vals[*s as usize] += v;
                }
                scatter_add(&e.fe, p.mesh.elem_nodes(elem), ldpn, dpn, &mut f_out);
                stress.extend_from_slice(&e.stress);
                strain.extend_from_slice(&e.strain);
                if let Some(st) = &mut state {
                    st.set(elem, &e.state);
                }
            }
        }
    }
    let (f_thermal, f_int) = if nl.is_some() { (Vec::new(), f_out) } else { (f_out, Vec::new()) };
    Ok(Assembled {
        k,
        f_thermal,
        f_int,
        stress_gp: FieldData::new(Per::ElemGp, VOIGT, stress),
        strain_gp: FieldData::new(Per::ElemGp, VOIGT, strain),
        state: state.unwrap_or_default(),
        min_det_j,
    })
}

/// `∫ Bᵀ D α ΔT dV` alone, at the Problem's current `temperature` — every DOF's thermal load
/// with no stiffness recomputed.
///
/// `K` never depends on temperature, only the thermal load does, so a chained static Step
/// (#84: one solve per retained frame of a heat-transient predecessor's History) assembles and
/// factorises `K` exactly once and calls this per frame instead of re-running
/// [`assemble_stiffness`], which would repeat the far more expensive element stiffness integral
/// for an answer that never changes. Sequential, like the heat matrix, because the payload is
/// one value per DOF rather than the `dpn²` block a stiffness entry needs.
pub fn thermal_load(p: &Problem<'_>) -> Result<Vec<f64>, Error> {
    let dpn = p.dofs_per_node();
    let mut f_thermal = vec![0.0; p.n_dofs()];
    let mut coords = Vec::new();
    let mut t = Vec::new();
    let mut fe = Vec::new();
    for blk in &p.mesh.blocks {
        let element = element_for(blk.kind);
        let nn = blk.kind.n_nodes();
        coords.resize(nn * 3, 0.0);
        t.resize(nn, 0.0);
        fe.resize(nn * dpn, 0.0);
        for i in 0..blk.n_elems() {
            let elem = blk.first_elem + i as u32;
            p.mesh.elem_coords(elem, &mut coords);
            p.gather_temperature(elem, &mut t);
            let c = p.ctx(elem, &coords, &t)?;
            fe.iter_mut().for_each(|v| *v = 0.0);
            element.thermal_load(&c, &mut fe).map_err(|e| e.at(format!("element {elem}")))?;
            let conn = p.mesh.elem_nodes(elem);
            for (a, &node) in conn.iter().enumerate() {
                for c in 0..dpn {
                    f_thermal[node as usize * dpn + c] += fe[a * dpn + c];
                }
            }
        }
    }
    Ok(f_thermal)
}

/// Constraints resolved to `(dof, value)` pairs, ascending and unique, with the Constraint
/// each pair came from so reactions can be reported per Constraint.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedConstraints {
    pub fixed: Vec<(u32, f64)>,
    /// Index into `Problem::constraints`, parallel to `fixed`.
    pub owner: Vec<usize>,
    /// The rotational DOFs of nodes no beam reaches, ascending ([`Problem::inert_dofs`]).
    /// They have no stiffness, no mass, no Constraint and no reaction: [`reduce`] drops them
    /// from the free set as it drops a multipoint slave, and nothing else ever names them.
    pub inert: Vec<u32>,
}

/// Resolve every Constraint against the Mesh's Sets. Two Constraints that prescribe different
/// values on one DOF are a `constraint.conflict`; the same value twice is not.
///
/// A Constraint's rotational components apply only where a rotation exists — the joints beam
/// elements reach. On every other node they are skipped rather than recorded, so a
/// `constraint.fix` on a solid's face holds three DOFs per node exactly as it did before beams
/// existed, and `checks::rigid_modes` never counts an inert rotation as a restraint.
pub fn resolve(p: &Problem<'_>) -> Result<ResolvedConstraints, Error> {
    let dpn = p.dofs_per_node();
    let rotational = if dpn > 3 { p.rotational_nodes() } else { Vec::new() };
    let mut all: Vec<(u32, f64, usize)> = Vec::new();
    for (i, c) in p.constraints.iter().enumerate() {
        let set = p.set(&c.nodes)?;
        for &node in &set.nodes {
            // Components past the stride are trailing `false`s under every idealisation (the
            // mask is six wide and the widest stride is six), so `take(dpn)` drops nothing real.
            for (d, on) in c.dofs.iter().enumerate().take(dpn) {
                if *on && (d < 3 || rotational[node as usize]) {
                    all.push((node * dpn as u32 + d as u32, c.value, i));
                }
            }
        }
    }
    all.sort_by(|a, b| a.0.cmp(&b.0).then(a.2.cmp(&b.2)));
    let mut fixed: Vec<(u32, f64)> = Vec::with_capacity(all.len());
    let mut owner = Vec::with_capacity(all.len());
    for (dof, value, from) in all {
        match fixed.last() {
            Some(&(d, v)) if d == dof => {
                if v != value {
                    return Err(conflict(p, dof, dpn, owner[owner.len() - 1], from, v, value));
                }
            }
            _ => {
                fixed.push((dof, value));
                owner.push(from);
            }
        }
    }
    Ok(ResolvedConstraints { fixed, owner, inert: p.inert_dofs() })
}

/// The `constraint.conflict` error: which node, which component, which two Constraints.
fn conflict(p: &Problem<'_>, dof: u32, dpn: usize, first: usize, second: usize, a: f64, b: f64) -> Error {
    let comp = p.dof_labels()[dof as usize % dpn];
    let (n1, n2) = (&p.constraints[first].name, &p.constraints[second].name);
    Error::new(
        ErrorCode::ConstraintConflict,
        format!("'{n1}' and '{n2}' prescribe {comp} of node {} as {a} and {b}", dof as usize / dpn),
    )
    .at(format!("constraint '{n2}'"))
    .suggest("constraint.remove one of them, or give them the same value")
}

/// The system with the constrained DOFs eliminated: `K_ff u_f = f_f − K_fc u_c`.
#[derive(Debug, Clone, PartialEq)]
pub struct Reduced {
    /// Free DOF ids, ascending.
    pub free: Vec<u32>,
    /// Constrained DOF ids, ascending.
    pub fixed: Vec<u32>,
    /// Prescribed values, parallel to `fixed`.
    pub u_fixed: Vec<f64>,
    pub k_ff: Csr,
    pub f_f: Vec<f64>,
    /// Full DOF id → index into `free`, or `-1` when the DOF is constrained.
    pub map: Vec<i64>,
}

/// Eliminate the constrained DOFs in one walk over the rows: the free-free entries build
/// `K_ff`, the free-constrained ones move to the right-hand side.
///
/// `eliminated` are DOFs that are not unknowns either but carry no prescribed value: the slaves
/// of a multipoint constraint, whose row and column `mpc::transform` has already emptied. They
/// leave the free set exactly like a DOF fixed at zero, which is exact because their columns
/// are exactly zero, and `mpc::recover` fills them in after `expand`. The inert rotations of
/// `rc` leave it the same way, and stay zero.
pub fn reduce(k: &Csr, f: &[f64], rc: &ResolvedConstraints, eliminated: &[u32]) -> Reduced {
    let mut map = vec![0i64; k.n];
    for &(d, _) in &rc.fixed {
        map[d as usize] = -1;
    }
    for &d in eliminated.iter().chain(&rc.inert) {
        map[d as usize] = -1;
    }
    let mut free = Vec::with_capacity(k.n - rc.fixed.len() - rc.inert.len());
    let mut u_full = vec![0.0; k.n];
    for &(d, v) in &rc.fixed {
        u_full[d as usize] = v;
    }
    for (d, m) in map.iter_mut().enumerate() {
        if *m == 0 {
            *m = free.len() as i64;
            free.push(d as u32);
        }
    }
    let mut row_ptr = vec![0u32; free.len() + 1];
    let mut col_idx = Vec::new();
    let mut vals = Vec::new();
    let mut f_f = vec![0.0; free.len()];
    for (r, &dof) in free.iter().enumerate() {
        let mut rhs = f[dof as usize];
        for e in k.row_ptr[dof as usize] as usize..k.row_ptr[dof as usize + 1] as usize {
            let c = map[k.col_idx[e] as usize];
            if c >= 0 {
                col_idx.push(c as u32);
                vals.push(k.vals[e]);
            } else {
                rhs -= k.vals[e] * u_full[k.col_idx[e] as usize];
            }
        }
        f_f[r] = rhs;
        row_ptr[r + 1] = col_idx.len() as u32;
    }
    Reduced {
        free,
        fixed: rc.fixed.iter().map(|&(d, _)| d).collect(),
        u_fixed: rc.fixed.iter().map(|&(_, v)| v).collect(),
        k_ff: Csr { n: row_ptr.len() - 1, row_ptr, col_idx, vals },
        f_f,
        map,
    }
}

/// The free solution scattered back into a full DOF vector, with the prescribed values in place.
pub fn expand(r: &Reduced, u_f: &[f64]) -> Vec<f64> {
    let mut u = vec![0.0; r.map.len()];
    for (i, &dof) in r.free.iter().enumerate() {
        u[dof as usize] = u_f[i];
    }
    for (i, &dof) in r.fixed.iter().enumerate() {
        u[dof as usize] = r.u_fixed[i];
    }
    u
}

/// `R = K u − f` on the constrained DOFs and zero elsewhere: the force the supports carry.
///
/// `k` and `f` are the **original** operator and load, never the transformed ones, so a
/// multipoint constraint's internal force can never be mistaken for a support reaction. That
/// is not quite the whole story, though: at a DOF that is both held and a master of a tie, the
/// residual `K u − f` is the support force *plus* the force the tie pushes into it, because the
/// solved system only enforces equilibrium of the retained combination. `mpc::master_forces`
/// adds that back, so what a support reports is what the support carries — and the sum over the
/// supports balances the applied load whether or not a tie reaches them.
pub fn reactions(k: &Csr, u: &[f64], f: &[f64], fixed: &[u32], mpc: &crate::fem::mpc::Mpc) -> Vec<f64> {
    let mut residual = vec![0.0; k.n];
    k.spmv(u, &mut residual);
    for (i, v) in residual.iter_mut().enumerate() {
        *v -= f[i];
    }
    let mut tie = vec![0.0; k.n];
    crate::fem::mpc::master_forces(mpc, &residual, &mut tie);
    let mut out = vec![0.0; k.n];
    for &dof in fixed {
        out[dof as usize] = residual[dof as usize] + tie[dof as usize];
    }
    out
}
