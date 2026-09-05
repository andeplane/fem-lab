//! Linear static equilibrium: checks → pattern → assemble → reduce → solve → expand →
//! reactions → post (plan A §6).

use std::collections::BTreeMap;

use crate::command::Field;
use crate::engine::OnProgress;
use crate::error::Error;
use crate::fem::problem::Problem;
use crate::fem::{assembly, checks, loads};
use crate::par::Pool;
use crate::post::{extremes, reactions_per_constraint, stress, FieldData, Per};
use crate::procedure::{report, StepResult};
use crate::solve::{solve, SolveOptions};

/// Solve one linear static Step.
pub async fn run(
    p: &Problem<'_>,
    opts: &SolveOptions,
    pool: &Pool,
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
    // One `?`: the loads and the stiffness fail on the same materials and the same Sets, both
    // of which `checks::all` has already looked at, so a second one would be an arm no test
    // could take.
    let (a, applied, f) = pool.install(|| {
        assembly::assemble_stiffness(p, &pat).and_then(|a| {
            let mut f = a.f_thermal.clone();
            loads::assemble_loads(p, &mut f).map(|applied| (a, applied, f))
        })
    })?;
    // `checks::all` has already resolved these and found no conflict.
    let rc = assembly::resolve(p).expect("the checks resolved the constraints");
    let red = assembly::reduce(&a.k, &f, &rc);
    let (u_f, solver) = solve(&red.k_ff, &red.f_f, opts, pool, gpu, &mut progress).await?;
    let u = assembly::expand(&red, &u_f);
    let r = assembly::reactions(&a.k, &u, &f, &red);
    report(&mut progress, "post", 0.9, "recovering fields")?;

    // The stiffness integral above already called this material on these elements, so the
    // recovery cannot fail here; `stress_gp` still reports it for a caller that skipped it.
    let (gp_stress, gp_strain) =
        pool.install(|| stress::stress_gp(p, &u)).expect("the stiffness integral accepted this material");
    let unaveraged = stress::gp_to_nodes(p.mesh, &gp_stress);
    let nodal_stress = stress::average_at_nodes(p, &unaveraged);
    let nodal_strain = stress::average_at_nodes(p, &stress::gp_to_nodes(p.mesh, &gp_strain));
    let mut fields = BTreeMap::new();
    fields.insert(Field::Displacement, vector_field(&u, dpn));
    fields.insert(Field::Reaction, vector_field(&r, dpn));
    fields.insert(Field::VonMises, stress::von_mises(&nodal_stress));
    fields.insert(Field::Principal, stress::principal(&nodal_stress));
    fields.insert(Field::Stress, nodal_stress);
    fields.insert(Field::StressUnaveraged, unaveraged);
    fields.insert(Field::Strain, nodal_strain);
    let mut scalars = BTreeMap::new();
    scalars.insert("min_det_j".to_string(), a.min_det_j);
    for (c, axis) in ["x", "y", "z"].iter().enumerate() {
        scalars.insert(format!("applied_total_{axis}"), applied.force[c]);
    }
    scalars.insert("rel_residual".to_string(), solver.rel_residual);
    let ex = fields
        .iter()
        .filter(|(_, f)| f.per == Per::Node)
        .flat_map(|(name, f)| extremes(f, p.mesh).into_iter().map(|e| (*name, e)))
        .collect();
    let reactions = reactions_per_constraint(p, &rc, &fields[&Field::Reaction]);
    Ok(StepResult { fields, scalars, extremes: ex, reactions, solver, warnings: Vec::new() })
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
