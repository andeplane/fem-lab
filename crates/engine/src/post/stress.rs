//! Stress and strain: recovered at the Gauss points, extrapolated to the element nodes,
//! averaged where that is legitimate, and reduced to von Mises and principal values
//! (plan A §8).
//!
//! Stress is not a nodal quantity. It is computed where the quadrature is accurate — the Gauss
//! points — and everything after that is a choice. This module makes the choices explicit:
//! [`gp_to_nodes`] fits the element's corner shape functions to its own Gauss values in the
//! least-squares sense and keeps the result *per element node*, so the jump between
//! neighbouring elements is visible and is the honest error estimate; [`average_at_nodes`]
//! then smooths it, and refuses to smooth across a material boundary where the jump is real.

use femlab_geometry::{ElementKind, Mesh};

use crate::error::Error;
use crate::fem::element::element_for;
use crate::fem::material::VOIGT;
use crate::fem::problem::Problem;
use crate::fem::shape::{rule_of, shape_of};
use crate::par;
use crate::post::{FieldData, Per};

/// Elements per parallel chunk, a constant so the work partition never depends on threads.
const CHUNK: usize = 2048;

/// The linear element whose shape functions span the extrapolation: the corners of `kind`,
/// which for a kind that is already linear is the kind itself.
fn corner_kind(kind: ElementKind) -> ElementKind {
    match kind {
        ElementKind::Hex20 => ElementKind::Hex8,
        ElementKind::Tet10 => ElementKind::Tet4,
        ElementKind::Quad8 => ElementKind::Quad4,
        ElementKind::Tri6 => ElementKind::Tri3,
        linear => linear,
    }
}

/// Total strain and stress at every Gauss point of every element, elements in order.
///
/// Both come back as [`Per::ElemGp`] fields of `VOIGT` components. `u` is the full nodal
/// displacement vector in the Problem's DOF numbering.
pub fn stress_gp(p: &Problem<'_>, u: &[f64]) -> Result<(FieldData, FieldData), Error> {
    let dpn = p.dofs_per_node();
    let mut stress = Vec::new();
    let mut strain = Vec::new();
    for blk in &p.mesh.blocks {
        let element = element_for(blk.kind);
        let ldpn = p.node_dofs(blk.kind);
        let (nn, n_gp) = (blk.kind.n_nodes(), element.n_gp());
        for lo in (0..blk.n_elems()).step_by(CHUNK) {
            let hi = (lo + CHUNK).min(blk.n_elems());
            let parts = par::map_collect(hi - lo, |i| {
                let elem = blk.first_elem + (lo + i) as u32;
                let mut coords = vec![0.0; nn * 3];
                p.mesh.elem_coords(elem, &mut coords);
                let mut t = vec![0.0; nn];
                p.gather_temperature(elem, &mut t);
                let mut ue = vec![0.0; nn * ldpn];
                crate::fem::assembly::gather(u, p.mesh.elem_nodes(elem), ldpn, dpn, &mut ue);
                let (mut sig, mut eps) = (vec![0.0; n_gp * VOIGT], vec![0.0; n_gp * VOIGT]);
                p.ctx(elem, &coords, &t).and_then(|c| element.recover(&c, &ue, &mut sig, &mut eps)).map(|()| (sig, eps))
            });
            for part in parts {
                let (sig, eps) = part?;
                stress.extend_from_slice(&sig);
                strain.extend_from_slice(&eps);
            }
        }
    }
    Ok((FieldData::new(Per::ElemGp, VOIGT, stress), FieldData::new(Per::ElemGp, VOIGT, strain)))
}

/// Stress at one physical shell surface (`side` = +1 top, -1 bottom). Element
/// nodes retain each patch's stress independently, including at shared creases.
pub(crate) fn shell_surface_stress(p: &Problem<'_>, u: &[f64], side: f64) -> Result<FieldData, Error> {
    let dpn = p.dofs_per_node();
    let mut stress = Vec::new();
    for blk in &p.mesh.blocks {
        if blk.kind != ElementKind::Shell4 {
            stress.resize(stress.len() + blk.n_elems() * element_for(blk.kind).n_gp() * VOIGT, 0.0);
            continue;
        }
        for i in 0..blk.n_elems() {
            let elem = blk.first_elem + i as u32;
            let mut coords = [0.0; 12];
            let mut temp = [0.0; 4];
            let mut ue = [0.0; 24];
            p.mesh.elem_coords(elem, &mut coords);
            p.gather_temperature(elem, &mut temp);
            crate::fem::assembly::gather(u, p.mesh.elem_nodes(elem), 6, dpn, &mut ue);
            let c = p.ctx(elem, &coords, &temp)?;
            let z = side * crate::fem::shell::thickness(&c)? * 0.5;
            let (mut sig, mut eps) = ([0.0; 24], [0.0; 24]);
            crate::fem::shell::recover_at(&c, &ue, z, &mut sig, &mut eps)?;
            stress.extend(sig);
        }
    }
    Ok(gp_to_nodes(p.mesh, &FieldData::new(Per::ElemGp, VOIGT, stress)))
}

/// Shell stress first moment, integral z*sigma dz in global tensor axes. Two thickness
/// Gauss points integrate a homogeneous flat section exactly. Keep each element's
/// values separate, just as for surface stress; other element kinds carry zeros.
pub(crate) fn shell_moments(p: &Problem<'_>, u: &[f64]) -> Result<FieldData, Error> {
    let dpn = p.dofs_per_node();
    let mut moments = Vec::new();
    for blk in &p.mesh.blocks {
        if blk.kind != ElementKind::Shell4 {
            moments.resize(moments.len() + blk.n_elems() * element_for(blk.kind).n_gp() * VOIGT, 0.0);
            continue;
        }
        for i in 0..blk.n_elems() {
            let elem = blk.first_elem + i as u32;
            let mut coords = [0.0; 12];
            let mut temp = [0.0; 4];
            let mut ue = [0.0; 24];
            p.mesh.elem_coords(elem, &mut coords);
            p.gather_temperature(elem, &mut temp);
            crate::fem::assembly::gather(u, p.mesh.elem_nodes(elem), 6, dpn, &mut ue);
            let c = p.ctx(elem, &coords, &temp)?;
            let t = crate::fem::shell::thickness(&c)?;
            let mut moment = [0.0; 24];
            for z in [-t / libm::sqrt(12.0), t / libm::sqrt(12.0)] {
                let (mut sig, mut eps) = ([0.0; 24], [0.0; 24]);
                crate::fem::shell::recover_at(&c, &ue, z, &mut sig, &mut eps)?;
                for (m, s) in moment.iter_mut().zip(sig) {
                    *m += 0.5 * t * z * s;
                }
            }
            moments.extend(moment);
        }
    }
    Ok(gp_to_nodes(p.mesh, &FieldData::new(Per::ElemGp, VOIGT, moments)))
}

/// The section forces (`N, V_y, V_z`) and moments (`T, M_y, M_z`) of every beam element at
/// each of its two nodes, as two [`Per::ElemNode`] fields of three components, elements in
/// order; every node of every other element carries zeros, so the two fields line up with
/// `stressUnaveraged`. This is the per-member view a joint's averaged stress cannot give.
pub fn section_fields(p: &Problem<'_>, u: &[f64]) -> Result<(FieldData, FieldData), Error> {
    let dpn = p.dofs_per_node();
    let mut force = Vec::new();
    let mut moment = Vec::new();
    for blk in &p.mesh.blocks {
        let nn = blk.kind.n_nodes();
        if blk.kind != ElementKind::Beam2 {
            force.resize(force.len() + blk.n_elems() * nn * 3, 0.0);
            moment.resize(moment.len() + blk.n_elems() * nn * 3, 0.0);
            continue;
        }
        let mut coords = vec![0.0; nn * 3];
        let mut t = vec![0.0; nn];
        let mut ue = vec![0.0; nn * dpn];
        for i in 0..blk.n_elems() {
            let elem = blk.first_elem + i as u32;
            p.mesh.elem_coords(elem, &mut coords);
            p.gather_temperature(elem, &mut t);
            crate::fem::assembly::gather(u, p.mesh.elem_nodes(elem), dpn, dpn, &mut ue);
            let ends = p.ctx(elem, &coords, &t).and_then(|c| crate::fem::beam::section_forces(&c, &ue))?;
            for end in ends {
                force.extend_from_slice(&end[..3]);
                moment.extend_from_slice(&end[3..]);
            }
        }
    }
    Ok((FieldData::new(Per::ElemNode, 3, force), FieldData::new(Per::ElemNode, 3, moment)))
}

/// Rows of the `n_nodes × n_gp` extrapolation matrix of one element kind, row-major.
///
/// The corner shape functions are fitted to the Gauss values in the least-squares sense,
/// `X = (Aᵀ A)⁻¹ Aᵀ` with `A[g][c] = N_c(ξ_g)`, which is the exact Gauss-to-node extrapolation
/// wherever `A` is square (hex8, quad4, tet10, tri6). A mid-edge node takes the mean of the two
/// corners it lies between, and a one-point rule has nothing to fit, so every node takes the
/// single Gauss value.
fn extrapolation(kind: ElementKind) -> Vec<f64> {
    let rule = rule_of(kind);
    let n_gp = rule.points.len();
    let (nn, nc) = (kind.n_nodes(), kind.n_corners());
    if n_gp == 1 {
        return vec![1.0; nn];
    }
    let corner = corner_kind(kind);
    let mut a = vec![0.0; n_gp * nc];
    let mut n = vec![0.0; nc];
    for (g, &xi) in rule.points.iter().enumerate() {
        shape_of(corner, xi, &mut n);
        a[g * nc..(g + 1) * nc].copy_from_slice(&n);
    }
    // normal equations, then one Cholesky solve per Gauss point
    let mut ata = vec![0.0; nc * nc];
    for i in 0..nc {
        for j in 0..nc {
            ata[i * nc + j] = (0..n_gp).map(|g| a[g * nc + i] * a[g * nc + j]).sum();
        }
    }
    cholesky(&mut ata, nc);
    let mut x = vec![0.0; nn * n_gp];
    let mut rhs = vec![0.0; nc];
    for g in 0..n_gp {
        for (i, r) in rhs.iter_mut().enumerate() {
            *r = a[g * nc + i];
        }
        cholesky_solve(&ata, nc, &mut rhs);
        for (c, &v) in rhs.iter().enumerate() {
            x[c * n_gp + g] = v;
        }
    }
    for (i, &[p, q]) in kind.edges().iter().enumerate().take(nn - nc) {
        for g in 0..n_gp {
            x[(nc + i) * n_gp + g] = 0.5 * (x[p as usize * n_gp + g] + x[q as usize * n_gp + g]);
        }
    }
    x
}

/// In-place lower Cholesky of a symmetric positive-definite `n × n` matrix.
fn cholesky(a: &mut [f64], n: usize) {
    for i in 0..n {
        for j in 0..=i {
            let mut s = a[i * n + j];
            for k in 0..j {
                s -= a[i * n + k] * a[j * n + k];
            }
            a[i * n + j] = if i == j { s.sqrt() } else { s / a[j * n + j] };
        }
    }
}

/// `b ← A⁻¹ b` for the factor [`cholesky`] left behind.
fn cholesky_solve(l: &[f64], n: usize, b: &mut [f64]) {
    for i in 0..n {
        let mut s = b[i];
        for k in 0..i {
            s -= l[i * n + k] * b[k];
        }
        b[i] = s / l[i * n + i];
    }
    for i in (0..n).rev() {
        let mut s = b[i];
        for k in i + 1..n {
            s -= l[k * n + i] * b[k];
        }
        b[i] = s / l[i * n + i];
    }
}

/// The number of Gauss points of every element, and where each element's block starts.
fn gp_offsets(mesh: &Mesh) -> Vec<usize> {
    let mut out = Vec::with_capacity(mesh.n_elems() + 1);
    let mut at = 0;
    out.push(0);
    for e in 0..mesh.n_elems() as u32 {
        at += element_for(mesh.kind_of(e)).n_gp();
        out.push(at);
    }
    out
}

/// Gauss-point values extrapolated to each element's own nodes, unaveraged.
pub fn gp_to_nodes(mesh: &Mesh, gp: &FieldData) -> FieldData {
    let comps = gp.comps;
    let offsets = gp_offsets(mesh);
    let mut data = Vec::new();
    for e in 0..mesh.n_elems() as u32 {
        let kind = mesh.kind_of(e);
        let (nn, n_gp) = (kind.n_nodes(), offsets[e as usize + 1] - offsets[e as usize]);
        let x = extrapolation(kind);
        let base = offsets[e as usize] * comps;
        for a in 0..nn {
            for c in 0..comps {
                data.push((0..n_gp).map(|g| x[a * n_gp + g] * gp.data[base + g * comps + c]).sum());
            }
        }
    }
    FieldData::new(Per::ElemNode, comps, data)
}

/// The mean of the element-node values meeting at each node, in ascending element order.
///
/// Averaging stops at a material boundary, where the stress jump is physical: a node takes the
/// mean over the elements that share the material of the lowest-numbered element at that node,
/// and the elements of the other material keep their own values in the unaveraged field.
pub fn average_at_nodes(p: &Problem<'_>, elem_node: &FieldData) -> FieldData {
    let mesh = p.mesh;
    let comps = elem_node.comps;
    let adj = mesh.node_to_elems();
    // where each element's node values start
    let mut offset = Vec::with_capacity(mesh.n_elems() + 1);
    let mut at = 0;
    offset.push(0);
    for e in 0..mesh.n_elems() as u32 {
        at += mesh.kind_of(e).n_nodes();
        offset.push(at);
    }
    let material = |e: u32| p.material_of_block[mesh.block_of(e).0];
    let data = par::map_collect(mesh.n_nodes(), |node| {
        let elems = adj.of(node);
        // A point mass is a node no element touches: it has no stress, and no first element
        // whose material would decide what to average.
        if elems.is_empty() {
            return vec![0.0; comps];
        }
        let keep = material(elems[0]);
        let mut sum = vec![0.0; comps];
        let mut count = 0.0;
        for &e in elems.iter().filter(|&&e| material(e) == keep) {
            let local = mesh.elem_nodes(e).iter().position(|&n| n as usize == node).expect("incident");
            let base = (offset[e as usize] + local) * comps;
            for (c, s) in sum.iter_mut().enumerate() {
                *s += elem_node.data[base + c];
            }
            count += 1.0;
        }
        for s in sum.iter_mut() {
            *s /= count;
        }
        sum
    });
    FieldData::new(Per::Node, comps, data.into_iter().flatten().collect())
}

/// Von Mises equivalent stress, one component per entity.
pub fn von_mises(stress: &FieldData) -> FieldData {
    let data = (0..stress.len())
        .map(|i| {
            let s = &stress.data[i * stress.comps..i * stress.comps + VOIGT];
            let d = 0.5 * ((s[0] - s[1]).powi(2) + (s[1] - s[2]).powi(2) + (s[2] - s[0]).powi(2));
            (d + 3.0 * (s[3] * s[3] + s[4] * s[4] + s[5] * s[5])).sqrt()
        })
        .collect();
    FieldData::new(stress.per, 1, data)
}

/// Jacobi sweeps stop once every off-diagonal is this small relative to the trace norm.
const JACOBI_TOL: f64 = 1e-18;
/// Cyclic Jacobi sweeps; three is enough for a 3×3, ten is a wide margin.
const JACOBI_SWEEPS: usize = 10;

/// The three principal stresses, descending.
pub fn principal(stress: &FieldData) -> FieldData {
    let data = (0..stress.len())
        .flat_map(|i| {
            let s = &stress.data[i * stress.comps..i * stress.comps + VOIGT];
            eigen3([[s[0], s[3], s[4]], [s[3], s[1], s[5]], [s[4], s[5], s[2]]])
        })
        .collect();
    FieldData::new(stress.per, 3, data)
}

/// Eigenvalues of a symmetric 3×3 by cyclic Jacobi, descending. Deterministic: a fixed sweep
/// order and a fixed number of sweeps, no pivoting on magnitude.
fn eigen3(mut a: [[f64; 3]; 3]) -> [f64; 3] {
    let scale = (0..3).map(|i| a[i][i].abs()).fold(0.0f64, f64::max).max(f64::MIN_POSITIVE);
    for _ in 0..JACOBI_SWEEPS {
        for (p, q) in [(0usize, 1usize), (0, 2), (1, 2)] {
            if a[p][q].abs() <= JACOBI_TOL * scale {
                continue;
            }
            let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
            let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
            let c = 1.0 / (t * t + 1.0).sqrt();
            let s = t * c;
            let mut b = a;
            for k in 0..3 {
                b[k][p] = c * a[k][p] - s * a[k][q];
                b[k][q] = s * a[k][p] + c * a[k][q];
            }
            let col = b;
            for k in 0..3 {
                b[p][k] = c * col[p][k] - s * col[q][k];
                b[q][k] = s * col[p][k] + c * col[q][k];
            }
            a = b;
        }
    }
    let mut e = [a[0][0], a[1][1], a[2][2]];
    e.sort_by(|x, y| y.total_cmp(x));
    e
}
