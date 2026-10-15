//! Zienkiewicz–Zhu recovery on linear simplices. The recovered stress/heat flux is
//! continuous within each material patch, with volume-weighted nodal averages.
//! Local squared errors are ∫(q*−q)ᵀ C⁻¹(q*−q); C is the elastic tangent or
//! conductivity. These are indicators, not guaranteed upper bounds on the true error.

use std::collections::BTreeMap;

use femlab_geometry::ElementKind;

use crate::error::{Error, ErrorCode};
use crate::fem::element::{grad_of, inverted, jac_inv, scale_at, tangent_at_zero};
use crate::fem::problem::Problem;
use crate::fem::shape::{dshape_of, product_rule_of, shape_of};
use crate::model::Idealisation;
use crate::par;
use crate::post::{stress, FieldData, Per};

/// Element-order energy contributions and their dimensionless global relative estimate.
#[derive(Debug, Clone, PartialEq)]
pub struct Estimate {
    pub squared_errors: Vec<f64>,
    pub squared_norm: f64,
}

impl Estimate {
    /// η / sqrt(||q||² + η²); zero for an exactly constant zero field.
    pub fn relative(&self) -> f64 {
        let error: f64 = self.squared_errors.iter().sum();
        if error + self.squared_norm == 0.0 {
            0.0
        } else {
            (error / (error + self.squared_norm)).sqrt()
        }
    }
}

struct Cell {
    flux: Vec<f64>,
    cholesky: Vec<f64>,
    volume: f64,
    material: Option<usize>,
}

/// Recover a solved primary nodal field: one temperature component or displacement
/// in the Problem's DOF layout. Supports tri3/tet4, planar/3D linear elasticity and
/// conduction. Axisymmetry and higher-order fields need nonconstant flux recovery.
/// Material interfaces have independent recovered values on each side.
pub fn zz(p: &Problem<'_>, primary: &FieldData) -> Result<Estimate, Error> {
    if p.mesh.blocks.iter().any(|b| b.kind != ElementKind::Tri3 && b.kind != ElementKind::Tet4)
        || matches!(p.idealisation, Idealisation::Axisymmetric { .. })
    {
        return Err(Error::new(ErrorCode::Unsupported, "ZZ recovery requires planar tri3 or solid tet4 elements")
            .at("mesh")
            .suggest("mesh.set with a linear free or tet mesher"));
    }
    let stride = if p.heat { 1 } else { p.dofs_per_node() };
    if primary.per != Per::Node
        || primary.comps != stride
        || primary.len() != p.mesh.n_nodes()
        || primary.data.iter().any(|x| !x.is_finite())
    {
        return Err(Error::schema("the estimator needs a finite primary nodal field in the Problem's DOF layout")
            .at("field")
            .suggest("solve.run, then query.field"));
    }
    let stress = if p.heat { None } else { Some(stress::stress_gp(p, &primary.data)?.0) };
    let active: &[usize] = if p.heat {
        if p.mesh.dim == 2 {
            &[0, 1]
        } else {
            &[0, 1, 2]
        }
    } else if matches!(p.idealisation, Idealisation::PlaneStress { .. }) {
        &[0, 1, 3]
    } else {
        &[0, 1, 2, 3, 4, 5]
    };
    let nc = active.len();
    let cells: Result<Vec<_>, Error> = par::map_collect(p.mesh.n_elems(), |i| {
        let e = i as u32;
        let kind = p.mesh.kind_of(e);
        let nodes = p.mesh.elem_nodes(e);
        let mut coords = vec![0.0; nodes.len() * 3];
        p.mesh.elem_coords(e, &mut coords);
        let mut dn = vec![[0.0; 3]; nodes.len()];
        dshape_of(kind, [0.0; 3], &mut dn);
        let (inv, det) = jac_inv(kind.dim(), &coords, &dn).ok_or_else(inverted)?;
        let c = p.ctx(e, &coords, &[])?;
        let volume = det / if kind.dim() == 2 { 2.0 } else { 6.0 } * scale_at(&p.idealisation, [0.0; 3]);
        let (flux, tangent) = if let Some(s) = &stress {
            let d = tangent_at_zero(&c, 1)?;
            (
                active.iter().map(|&a| s.data[i * 6 + a]).collect(),
                active
                    .iter()
                    .flat_map(|&a| active.iter().map(move |&b| (a, b)))
                    .map(|(a, b)| d[a * 6 + b])
                    .collect::<Vec<_>>(),
            )
        } else {
            let k = c.material.conductivity_tensor();
            let mut gradient = [0.0; 3];
            for (&node, d) in nodes.iter().zip(&dn) {
                let g = grad_of(d, &inv, kind.dim());
                for a in 0..kind.dim() {
                    gradient[a] += g[a] * primary.data[node as usize];
                }
            }
            (
                (0..nc).map(|a| (0..nc).map(|b| k[a][b] * gradient[b]).sum()).collect(),
                (0..nc).flat_map(|a| (0..nc).map(move |b| k[a][b])).collect(),
            )
        };
        let matrix = faer::Mat::from_fn(nc, nc, |a, b| tangent[a * nc + b]);
        let factor = matrix.llt(faer::Side::Lower).map_err(|_| {
            Error::new(ErrorCode::MaterialProps, "the estimator requires a positive definite constitutive tensor")
                .at(format!("element {e}"))
                .suggest("material.add with positive elastic moduli or conductivity")
        })?;
        let lower = factor.L();
        let cholesky = (0..nc).flat_map(|a| (0..nc).map(move |b| (a, b))).map(|(a, b)| lower[(a, b)]).collect();
        Ok(Cell { flux, cholesky, volume, material: p.material_of_block[p.mesh.block_of(e).0] })
    })
    .into_iter()
    .collect();
    let cells = cells?;
    // Fixed element order for every patch reduction, independent of worker count.
    let mut patches: BTreeMap<(u32, Option<usize>), (Vec<f64>, f64)> = BTreeMap::new();
    for (i, c) in cells.iter().enumerate() {
        for &node in p.mesh.elem_nodes(i as u32) {
            let (sum, weight) = patches.entry((node, c.material)).or_insert_with(|| (vec![0.0; nc], 0.0));
            for (s, q) in sum.iter_mut().zip(&c.flux) {
                *s += c.volume * q;
            }
            *weight += c.volume;
        }
    }
    let squared_errors = par::map_collect(cells.len(), |i| {
        let c = &cells[i];
        let kind = p.mesh.kind_of(i as u32);
        let nodes = p.mesh.elem_nodes(i as u32);
        let rule = product_rule_of(kind);
        let reference_volume: f64 = rule.weights.iter().sum();
        let mut error = 0.0;
        let mut n = vec![0.0; nodes.len()];
        for (&xi, &w) in rule.points.iter().zip(rule.weights) {
            shape_of(kind, xi, &mut n);
            let mut delta: Vec<f64> = c.flux.iter().map(|q| -q).collect();
            for (&node, &shape) in nodes.iter().zip(&n) {
                let (sum, weight) = &patches[&(node, c.material)];
                for (d, s) in delta.iter_mut().zip(sum) {
                    *d += shape * s / weight;
                }
            }
            error += w * c.volume / reference_volume * energy(&delta, &c.cholesky);
        }
        error
    });
    let squared_norm: f64 = cells.iter().map(|c| c.volume * energy(&c.flux, &c.cholesky)).sum();
    let total = squared_norm + squared_errors.iter().sum::<f64>();
    if !total.is_finite() {
        return Err(Error::new(ErrorCode::SolveStalled, "the recovery energy overflowed")
            .at("field")
            .suggest("check material.add and load magnitudes, then solve.run"));
    }
    Ok(Estimate { squared_errors, squared_norm })
}

/// qᵀ C⁻¹q = ||L⁻¹q||² for C=LLᵀ. Triangular substitution avoids the
/// cancellation of an explicit inverse quadratic form and is nonnegative by construction.
fn energy(q: &[f64], lower: &[f64]) -> f64 {
    let mut transformed = vec![0.; q.len()];
    for a in 0..q.len() {
        let mut value = q[a];
        for b in 0..a {
            value -= lower[a * q.len() + b] * transformed[b];
        }
        transformed[a] = value / lower[a * q.len() + a];
    }
    transformed.iter().map(|x| x * x).sum()
}
