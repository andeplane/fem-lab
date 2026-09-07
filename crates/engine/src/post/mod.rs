//! Post-processing: the container every Result field lives in, its extremes, and the reactions
//! grouped by the Constraint that carried them (plan A §8).

pub mod convergence;
pub mod probe;
pub mod stress;

use femlab_geometry::Mesh;

use crate::fem::assembly::ResolvedConstraints;
use crate::fem::problem::Problem;

/// Where a field's values sit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Per {
    /// One value per mesh node.
    Node,
    /// One value per element Gauss point, elements in order.
    ElemGp,
    /// One value per element node, elements in order: the unaveraged view.
    ElemNode,
}

/// One Result field: `comps` components per entity, component-fastest.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldData {
    pub per: Per,
    pub comps: usize,
    pub data: Vec<f64>,
}

impl FieldData {
    pub fn new(per: Per, comps: usize, data: Vec<f64>) -> FieldData {
        FieldData { per, comps, data }
    }
    /// How many entities the field covers.
    pub fn len(&self) -> usize {
        self.data.len() / self.comps
    }
    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }
    /// One component as a contiguous vector, for a host that renders or exports it.
    pub fn component(&self, c: usize) -> Vec<f64> {
        self.data.iter().skip(c).step_by(self.comps).copied().collect()
    }
}

/// The smallest and largest value of one component, and where each sits.
#[derive(Debug, Clone, PartialEq)]
pub struct Extremum {
    pub component: usize,
    pub min: f64,
    pub min_at: [f64; 3],
    pub max: f64,
    pub max_at: [f64; 3],
}

/// Per-component extremes of a nodal field, with the node coordinates they occur at. Ties go
/// to the lowest node index, so the answer does not depend on iteration order.
pub fn extremes(f: &FieldData, mesh: &Mesh) -> Vec<Extremum> {
    (0..f.comps)
        .map(|c| {
            let (mut lo, mut hi) = (0usize, 0usize);
            for i in 1..f.len() {
                if f.data[i * f.comps + c] < f.data[lo * f.comps + c] {
                    lo = i;
                }
                if f.data[i * f.comps + c] > f.data[hi * f.comps + c] {
                    hi = i;
                }
            }
            Extremum {
                component: c,
                min: f.data[lo * f.comps + c],
                min_at: mesh.node(lo as u32),
                max: f.data[hi * f.comps + c],
                max_at: mesh.node(hi as u32),
            }
        })
        .collect()
}

/// The total force each Constraint carries, in Model order. A node held by two Constraints
/// belongs to the first one that claimed the DOF, which is what `resolve` recorded.
///
/// `reactions` is the Result's own three-component nodal field, so a host that has a
/// `StepResult` can regroup the reactions without re-deriving the DOF numbering. The three
/// components are forces; a clamped beam joint's reaction *moment* is not summed here (it is
/// the member's own end moment, in the `sectionMoment` field) so the totals stay one dimension.
pub fn reactions_per_constraint(
    p: &Problem<'_>,
    rc: &ResolvedConstraints,
    reactions: &FieldData,
) -> Vec<(String, [f64; 3])> {
    let dpn = p.dofs_per_node();
    let mut totals = vec![[0.0; 3]; p.constraints.len()];
    for (&(dof, _), &owner) in rc.fixed.iter().zip(&rc.owner) {
        let (node, comp) = (dof as usize / dpn, dof as usize % dpn);
        if comp < 3 {
            totals[owner][comp] += reactions.data[node * reactions.comps + comp];
        }
    }
    p.constraints.iter().map(|c| c.name.clone()).zip(totals).collect()
}
