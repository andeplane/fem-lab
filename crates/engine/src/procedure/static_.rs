//! Linear static equilibrium: checks → pattern → assemble → reduce → solve → expand →
//! reactions → post (plan A §6).

use std::collections::BTreeMap;

use crate::command::Field;
use crate::engine::OnProgress;
use crate::error::Error;
use crate::fem::problem::Problem;
use crate::fem::{assembly, checks};
use crate::post::{FieldData, Per};
use crate::procedure::{report, StepResult};
use crate::solve::{solve, SolveOptions};

/// Solve one linear static Step.
pub async fn run(
    p: &Problem<'_>,
    opts: &SolveOptions,
    gpu: Option<&crate::gpu::Gpu>,
    mut progress: OnProgress<'_>,
) -> Result<StepResult, Error> {
    // `solve.run` refuses with the first failing check; `query.model.warnings` lists them all.
    if let Some(e) = checks::all(p).into_iter().next() {
        return Err(e);
    }
    report(&mut progress, "assemble", 0.1, "building the sparsity pattern")?;
    let dpn = p.dofs_per_node();
    let pat = assembly::pattern(p.mesh, dpn);
    let a = assembly::assemble_stiffness(p, &pat)?;
    let f = a.f_thermal.clone();
    // `checks::all` has already resolved these and found no conflict.
    let rc = assembly::resolve(p).expect("the checks resolved the constraints");
    let red = assembly::reduce(&a.k, &f, &rc);
    let (u_f, solver) = solve(&red.k_ff, &red.f_f, opts, gpu, &mut progress).await?;
    let u = assembly::expand(&red, &u_f);
    let r = assembly::reactions(&a.k, &u, &f, &red);
    report(&mut progress, "post", 0.9, "recovering fields")?;

    let mut fields = BTreeMap::new();
    fields.insert(Field::Displacement, vector_field(&u, dpn));
    fields.insert(Field::Reaction, vector_field(&r, dpn));
    let mut scalars = BTreeMap::new();
    scalars.insert("min_det_j".to_string(), a.min_det_j);
    scalars.insert("rel_residual".to_string(), solver.rel_residual);
    Ok(StepResult { fields, scalars, solver, warnings: Vec::new() })
}

/// A per-node vector as three components, so a 2D Result reaches a host and a VTU writer with
/// the same shape as a 3D one (the z component is zero).
fn vector_field(v: &[f64], dofs_per_node: usize) -> FieldData {
    let n = v.len() / dofs_per_node;
    let mut data = vec![0.0; n * 3];
    for node in 0..n {
        for c in 0..dofs_per_node {
            data[node * 3 + c] = v[node * dofs_per_node + c];
        }
    }
    FieldData::new(Per::Node, 3, data)
}
