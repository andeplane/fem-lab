//! Per-Gauss-point material state, flat and offset-indexed.
//!
//! A history-dependent law (plasticity, damage) needs to know where its Gauss point *was* at
//! the last converged increment, and nothing else in the engine keeps that. This is the one
//! buffer that does. A nonlinear Step holds two of them: the last converged state, which every
//! trial evaluation reads, and the trial state the elements write. Committing a converged
//! increment swaps the two; rolling one back after a cutback is doing nothing at all, which is
//! the whole reason the trial buffer is separate rather than updated in place.
//!
//! The state is derived data. It never reaches a Command, never enters the Journal and is
//! dropped when the Step ends, so replay and the Model hash are untouched by it; restarting a
//! later Step from it is PLAN 6.6.

use crate::error::Error;
use crate::fem::element::element_for;
use crate::fem::problem::Problem;

/// The material state of every Gauss point of a Problem.
///
/// Element `e` owns `values[offsets[e]..offsets[e + 1]]`, which is `n_gp · law.n_state()`
/// long — zero for every material law that has no state, so a linear-elastic Problem
/// allocates only the offsets.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct GpState {
    /// `n_elems + 1` offsets into `values`.
    pub offsets: Vec<usize>,
    pub values: Vec<f64>,
}

impl GpState {
    /// The zero state of every Gauss point, sized from each element's rule and its material's
    /// law. Fails with `model.no-material` on a Body that has none, as every other integral
    /// over the Mesh does.
    pub fn new(p: &Problem<'_>) -> Result<GpState, Error> {
        let mut offsets = Vec::with_capacity(p.mesh.n_elems() + 1);
        offsets.push(0);
        let mut total = 0;
        for elem in 0..p.mesh.n_elems() as u32 {
            total += element_for(p.mesh.kind_of(elem)).n_gp() * p.material_of(elem)?.law.n_state();
            offsets.push(total);
        }
        Ok(GpState { offsets, values: vec![0.0; total] })
    }

    /// One element's state.
    pub fn of(&self, elem: u32) -> &[f64] {
        &self.values[self.offsets[elem as usize]..self.offsets[elem as usize + 1]]
    }

    /// Overwrite one element's state with what that element just advanced it to.
    pub fn set(&mut self, elem: u32, values: &[f64]) {
        let (lo, hi) = (self.offsets[elem as usize], self.offsets[elem as usize + 1]);
        self.values[lo..hi].copy_from_slice(values);
    }
}
