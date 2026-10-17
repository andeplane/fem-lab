//! Borrowed physical candidates: admit their construction before allocating any columns.

use femlab_geometry::Mesh;

use super::NearSpace;
use crate::error::{Error, ErrorCode};
use crate::fem::checks;
use crate::model::Idealisation;

pub(crate) const NEAR_SPACE_BYTES: usize = 256 << 20;

/// Geometry and retained displacement coordinates, borrowed until GPU setup is selected.
/// H=T E_free has identity retained rows: these are legal homogeneous corrections,
/// rather than the force pullback T^T. No basis storage is paid by a CPU solve.
#[derive(Clone, Copy)]
pub(crate) struct PhysicalSpace<'a> {
    pub mesh: &'a Mesh,
    pub idealisation: &'a Idealisation,
    pub free: &'a [u32],
    pub dofs_per_node: usize,
}

impl PhysicalSpace<'_> {
    pub(crate) fn materialize(self, limit: usize) -> Result<NearSpace, Error> {
        // Six full and reduced f64 columns, u32 groups, plus Vec metadata. Widen
        // before every product, including on wasm32; this is not a free-memory claim.
        let full = self.mesh.n_nodes() as u128 * self.dofs_per_node as u128;
        let bytes = (full + self.free.len() as u128) * 48 + self.free.len() as u128 * 4 + 1024;
        if bytes > limit as u128 {
            return Err(Error::new(
                ErrorCode::SolveTooLarge,
                format!("the reduced elastic near space exceeds its {limit}-byte construction bound"),
            )
            .at("solve/aggregation")
            .suggest("mesh.generate with a coarser size, or solve.run { solver: 'cpu-direct' }"));
        }
        let node_of_row = self.free.iter().map(|&dof| dof / self.dofs_per_node as u32).collect();
        let modes = checks::rigid_basis(self.mesh, self.idealisation, self.dofs_per_node)
            .into_iter()
            .map(|(_, full)| self.free.iter().map(|&dof| full[dof as usize]).collect())
            .collect();
        Ok(NearSpace { node_of_row, modes })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use femlab_geometry::{ElementKind, Structured};

    #[test]
    fn admitted_physical_columns_preserve_retained_translations_and_rotations() {
        let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([2.0, 2.0, 2.0]);
        let free = [0, 1, 5, 6];
        let input = PhysicalSpace { mesh: &mesh, idealisation: &Idealisation::Solid3d, free: &free, dofs_per_node: 3 };
        // 24 full and four reduced DOFs, six columns, four groups and metadata.
        let exact = 28 * 48 + 4 * 4 + 1024;
        let space = input.materialize(exact).unwrap();
        assert_eq!(space.node_of_row, [0, 0, 1, 2]);
        assert_eq!(space.modes.len(), 6);
        let translation = 1.0 / 8.0f64.sqrt();
        assert_eq!(space.modes[0], [translation, 0.0, 0.0, translation]);
        assert_eq!(space.modes[1], [0.0, translation, 0.0, 0.0]);
        // This cube's centered rotation has eight y and eight z entries of unit
        // magnitude, so its full normalization is four. Check retained coordinates.
        assert_eq!(space.modes[3], [0.0, 0.25, -0.25, 0.0]);
        let error = input.materialize(exact - 1).unwrap_err();
        assert_eq!(error.code, ErrorCode::SolveTooLarge);
        assert_eq!(error.where_.as_deref(), Some("solve/aggregation"));
        assert!(error.suggestion.unwrap().contains("coarser"));
    }
}
