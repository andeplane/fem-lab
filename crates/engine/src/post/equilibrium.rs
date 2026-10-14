//! Retained linear-static Cartesian force and moment equilibrium, in SI.
//!
//! A wrench about `reference` is `(F, (x-reference) × F + C)`, where `C` is a
//! rotational-DOF couple. Magnitudes are accumulated before Constraint grouping,
//! so opposite actions remain a physical scale even when their resultant is zero.

use crate::fem::assembly::ResolvedConstraints;
use crate::fem::problem::Problem;
use crate::model::Idealisation;
use crate::par::{self, Pool};
use femlab_geometry::Mesh;

#[derive(Debug, Clone, PartialEq)]
pub struct StaticEquilibrium {
    pub reference: [f64; 3],
    pub characteristic_length: f64,
    pub force_residual: [f64; 3],
    pub force_scale: f64,
    pub applied_moment: [f64; 3],
    pub reaction_moments: Vec<(String, [f64; 3])>,
    pub moment_residual: [f64; 3],
    pub moment_scale: f64,
}

pub fn norm(v: [f64; 3]) -> f64 {
    libm::hypot(libm::hypot(v[0], v[1]), v[2])
}

/// For retained accounting outputs, zero scale implies zero residual: the scale
/// sums magnitudes of every contributing action. No dimensional floor is used.
pub fn relative(residual: [f64; 3], scale: f64) -> f64 {
    if scale == 0.0 {
        0.0
    } else {
        norm(residual) / scale
    }
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn force_and_moment(values: &[f64], dpn: usize, arm: [f64; 3]) -> ([f64; 3], [f64; 3]) {
    let mut force = [0.0; 3];
    force[..dpn.min(3)].copy_from_slice(&values[..dpn.min(3)]);
    let mut moment = cross(arm, force);
    if dpn == 6 {
        for c in 0..3 {
            moment[c] += values[c + 3];
        }
    }
    (force, moment)
}

#[derive(Default)]
struct WrenchSums {
    length: f64,
    force_residual: [f64; 3],
    applied_moment: [f64; 3],
    reaction_moment: [f64; 3],
    applied_force_scale: f64,
    reaction_force_scale: f64,
    applied_moment_scale: f64,
    reaction_moment_scale: f64,
}

/// Pure wrench accounting for a nonempty Mesh; arrays use full Problem DOF order
/// and Constraint ownership. Both static recovery paths run checks::all first:
/// an empty Cartesian Problem leaves every rigid mode free and is rejected.
fn account(
    mesh: &Mesh,
    dpn: usize,
    applied: &[f64],
    thermal: Option<&[f64]>,
    reactions: &[f64],
    rc: &ResolvedConstraints,
    pool: &Pool,
) -> StaticEquilibrium {
    let reference = mesh.node(0);
    // Fixed-size chunks and index-order reduction match the engine's dot-product
    // convention. The injected Pool determines concurrency, never summation order.
    let partials = pool.install(|| {
        par::map_collect(mesh.n_nodes().div_ceil(par::DOT_CHUNK), |chunk| {
            let mut sum = WrenchSums::default();
            for node in chunk * par::DOT_CHUNK..((chunk + 1) * par::DOT_CHUNK).min(mesh.n_nodes()) {
                let arm = std::array::from_fn(|c| mesh.node(node as u32)[c] - reference[c]);
                sum.length = sum.length.max(norm(arm));
                let mut external = [0.0; 6];
                for (c, value) in external.iter_mut().enumerate().take(dpn) {
                    let i = node * dpn + c;
                    *value = applied[i] - thermal.map_or(0.0, |t| t[i]);
                }
                let (f, m) = force_and_moment(&external, dpn, arm);
                let (r, mr) = force_and_moment(&reactions[node * dpn..], dpn, arm);
                for c in 0..3 {
                    sum.force_residual[c] += f[c] + r[c];
                    sum.applied_moment[c] += m[c];
                    sum.reaction_moment[c] += mr[c];
                }
                sum.applied_force_scale += norm(f);
                sum.reaction_force_scale += norm(r);
                sum.applied_moment_scale += norm(m);
                sum.reaction_moment_scale += norm(mr);
            }
            sum
        })
    });
    let mut sum = WrenchSums::default();
    for part in partials {
        sum.length = sum.length.max(part.length);
        for c in 0..3 {
            sum.force_residual[c] += part.force_residual[c];
            sum.applied_moment[c] += part.applied_moment[c];
            sum.reaction_moment[c] += part.reaction_moment[c];
        }
        sum.applied_force_scale += part.applied_force_scale;
        sum.reaction_force_scale += part.reaction_force_scale;
        sum.applied_moment_scale += part.applied_moment_scale;
        sum.reaction_moment_scale += part.reaction_moment_scale;
    }
    let mut totals = vec![[0.0; 3]; rc.owner.iter().copied().max().map_or(0, |i| i + 1)];
    for (&(dof, _), &owner) in rc.fixed.iter().zip(&rc.owner) {
        let node = dof as usize / dpn;
        let component = dof as usize % dpn;
        let mut value = [0.0; 3];
        value[component % 3] = reactions[dof as usize];
        let moment = if component < 3 {
            cross(std::array::from_fn(|c| mesh.node(node as u32)[c] - reference[c]), value)
        } else {
            value
        };
        for c in 0..3 {
            totals[owner][c] += moment[c];
        }
    }
    let force_actions = sum.applied_force_scale.max(sum.reaction_force_scale);
    let moment_actions = sum.applied_moment_scale.max(sum.reaction_moment_scale);
    // A zero-span force-only point ledger still has meaningful force equilibrium.
    // Rotational loads on an inert/degenerate mesh are rejected before static recovery.
    let force_scale = if sum.length == 0.0 { force_actions } else { force_actions.max(moment_actions / sum.length) };
    StaticEquilibrium {
        reference,
        characteristic_length: sum.length,
        force_residual: sum.force_residual,
        force_scale,
        applied_moment: sum.applied_moment,
        reaction_moments: totals.into_iter().map(|total| (String::new(), total)).collect(),
        moment_residual: std::array::from_fn(|c| sum.applied_moment[c] + sum.reaction_moment[c]),
        moment_scale: moment_actions.max(force_actions * sum.length),
    }
}

/// Linear Cartesian static recovery only. Thermal equivalent nodal actions belong to
/// initial strain, not external load; exclude them from the applied wrench.
pub fn recover(
    p: &Problem<'_>,
    rc: &ResolvedConstraints,
    load: &[f64],
    thermal: Option<&[f64]>,
    reactions: &[f64],
    pool: &Pool,
) -> Option<StaticEquilibrium> {
    if let Idealisation::Axisymmetric { .. } = p.idealisation {
        return None;
    }
    let mut ledger = account(p.mesh, p.dofs_per_node(), load, thermal, reactions, rc, pool);
    // Retain every Constraint, including a Constraint owning no DOF after overlap resolution.
    ledger.reaction_moments.resize(p.constraints.len(), (String::new(), [0.0; 3]));
    for ((name, _), constraint) in ledger.reaction_moments.iter_mut().zip(&p.constraints) {
        name.clone_from(&constraint.name);
    }
    Some(ledger)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opposing_force_couple_pairs_account_for_every_chunk_at_one_and_four_threads() {
        // Each adjacent pair at x=2k and x=2k+1 carries +2/-2 N about y and a
        // +2 N m z couple on the second node: their combined force and moment vanish.
        // Opposite support actions have the same independent pairwise statics oracle.
        let nodes = 3 * par::DOT_CHUNK + 18;
        let pairs = nodes / 2;
        let mut coords = Vec::with_capacity(nodes * 3);
        let mut applied = vec![0.0; nodes * 6];
        let mut reactions = vec![0.0; nodes * 6];
        let mut fixed = Vec::with_capacity(nodes * 2);
        let mut owner = Vec::with_capacity(nodes * 2);
        for node in 0..nodes {
            coords.extend([node as f64, 0.0, 0.0]);
            let parity = node % 2;
            applied[node * 6 + 1] = if parity == 0 { 2.0 } else { -2.0 };
            applied[node * 6 + 5] = 2.0 * parity as f64;
            reactions[node * 6 + 1] = -applied[node * 6 + 1];
            reactions[node * 6 + 5] = -applied[node * 6 + 5];
            fixed.extend([((node * 6 + 1) as u32, 0.0), ((node * 6 + 5) as u32, 0.0)]);
            owner.extend([parity, parity]);
        }
        let mesh = Mesh {
            dim: 3,
            coords,
            blocks: vec![],
            node_sets: Default::default(),
            elem_sets: Default::default(),
            face_sets: Default::default(),
        };
        let rc = ResolvedConstraints { fixed, owner, inert: vec![] };
        let one = account(&mesh, 6, &applied, None, &reactions, &rc, &Pool::new(1));
        let four = account(&mesh, 6, &applied, None, &reactions, &rc, &Pool::new(4));
        assert_eq!(one, four);
        assert_eq!(one.reference, [0.0; 3]);
        assert_eq!(one.characteristic_length, (nodes - 1) as f64);
        assert_eq!(one.force_residual, [0.0; 3]);
        assert_eq!(one.applied_moment, [0.0; 3]);
        assert_eq!(one.moment_residual, [0.0; 3]);
        assert_eq!(one.force_scale, (2 * nodes) as f64);
        assert_eq!(one.moment_scale, (2 * nodes * (nodes - 1)) as f64);
        // Sum 2x over the even positions: 4 sum(k) = 2p(p-1).
        let grouped_moment = (2 * pairs * (pairs - 1)) as f64;
        assert_eq!(one.reaction_moments[0].1, [0.0, 0.0, -grouped_moment]);
        assert_eq!(one.reaction_moments[1].1, [0.0, 0.0, grouped_moment]);
    }

    #[test]
    fn zero_span_point_wrenches_do_not_need_a_length_floor() {
        let mesh = Mesh {
            dim: 3,
            coords: vec![3., 4., 5.],
            blocks: vec![],
            node_sets: Default::default(),
            elem_sets: Default::default(),
            face_sets: Default::default(),
        };
        let rc = ResolvedConstraints { fixed: vec![(0, 0.)], owner: vec![0], inert: vec![] };
        let ledger = account(&mesh, 3, &[7., 0., 0.], None, &[-7., 0., 0.], &rc, &Pool::new(1));
        assert_eq!(ledger.reference, [3., 4., 5.]);
        assert_eq!(ledger.characteristic_length, 0.);
        assert_eq!(ledger.force_scale, 7.);
        assert_eq!(ledger.force_residual, [0.; 3]);
        assert_eq!(relative(ledger.force_residual, ledger.force_scale), 0.);
        assert_eq!(ledger.moment_scale, 0.);
        assert_eq!(relative(ledger.moment_residual, ledger.moment_scale), 0.);
        let no_supports = ResolvedConstraints { fixed: vec![], owner: vec![], inert: vec![] };
        let zero = account(&mesh, 3, &[0.; 3], None, &[0.; 3], &no_supports, &Pool::new(1));
        assert_eq!(zero.reference, [3., 4., 5.]);
        assert_eq!(zero.force_residual, [0.; 3]);
        assert_eq!(zero.moment_residual, [0.; 3]);
        assert_eq!(zero.force_scale, 0.);
        assert_eq!(zero.moment_scale, 0.);
        assert_eq!(zero.reaction_moments, vec![]);
        assert_eq!(relative(zero.force_residual, zero.force_scale), 0.);
        assert_eq!(relative(zero.moment_residual, zero.moment_scale), 0.);
    }

    #[test]
    fn a_known_support_torque_and_a_real_imbalance_are_not_snapped_to_zero() {
        let mesh = Mesh {
            dim: 3,
            coords: vec![0., 0., 0., 2., 0., 0.],
            blocks: vec![],
            node_sets: Default::default(),
            elem_sets: Default::default(),
            face_sets: Default::default(),
        };
        let rc = ResolvedConstraints { fixed: vec![(0, 0.), (3, 0.), (9, 0.)], owner: vec![0, 0, 1], inert: vec![] };
        // GJθ/L = (80 GPa)(1e-6 m⁴)(0.01 rad)/(2 m) = 400 N m.
        let mut r = vec![0.; 12];
        r[3] = -400.;
        r[9] = 400.;
        let zero = [0.; 12];
        let ledger = account(&mesh, 6, &zero, None, &r, &rc, &Pool::new(1));
        assert_eq!(ledger.force_scale, 400.);
        assert_eq!(ledger.reaction_moments[0].1, [-400., 0., 0.]);
        assert_eq!(ledger.reaction_moments[1].1, [400., 0., 0.]);
        assert_eq!(ledger.moment_residual, [0.; 3]);
        r[0] = 1.;
        let bad = account(&mesh, 6, &zero, None, &r, &rc, &Pool::new(1));
        assert_eq!(bad.force_residual, [1., 0., 0.]);
        assert!(relative(bad.force_residual, bad.force_scale) > 1e-9);
        r[3] += 2.;
        let bad = account(&mesh, 6, &zero, None, &r, &rc, &Pool::new(1));
        assert_eq!(bad.moment_residual, [2., 0., 0.]);
        assert!(relative(bad.moment_residual, bad.moment_scale) > 1e-9);
    }
}
