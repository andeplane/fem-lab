//! Exact original-map acceptance: analytical polynomial shears, not a solver duplicate.
use femlab_geometry::{imported_certificate::certify_imported_geometry, ElementBlock, ElementKind, Mesh};

fn reference(tet: bool) -> Vec<[f64; 3]> {
    let (mut points, edges) = if tet {
        (
            vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
            vec![[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]],
        )
    } else {
        (
            vec![
                [0., 0., 0.],
                [1., 0., 0.],
                [1., 1., 0.],
                [0., 1., 0.],
                [0., 0., 1.],
                [1., 0., 1.],
                [1., 1., 1.],
                [0., 1., 1.],
            ],
            vec![[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]],
        )
    };
    for [a, b] in edges {
        points.push(std::array::from_fn(|k| (points[a][k] + points[b][k]) / 2.));
    }
    points
}

fn source(tet: bool, lower: bool, transform: fn([f64; 3]) -> [f64; 3]) -> Mesh {
    let kind = if tet { ElementKind::Tet10 } else { ElementKind::Hex20 };
    let mut points = Vec::new();
    let mut conn = Vec::new();
    for side in 0..if lower { 2 } else { 1 } {
        for [x, y, z] in reference(tet) {
            // Positive orientation on either side of the exact same curved face.
            let p = if side == 0 {
                [x, y, z]
            } else if tet {
                [y, x, -z]
            } else {
                [x, y, z - 1.]
            };
            let p = transform(p);
            let id = if let Some(id) = points.iter().position(|q| *q == p) {
                id
            } else {
                points.push(p);
                points.len() - 1
            };
            conn.push(id as u32);
        }
    }
    Mesh {
        dim: 3,
        coords: points.into_iter().flatten().collect(),
        blocks: vec![ElementBlock { kind, conn, first_elem: 0 }],
        node_sets: Default::default(),
        elem_sets: Default::default(),
        face_sets: Default::default(),
    }
}

fn shear([x, y, z]: [f64; 3]) -> [f64; 3] {
    [x, y, z + x * (1. - x) / 4.]
}

#[test]
fn exact_quadratic_certificate_retains_curved_cells_and_shared_interfaces() {
    // G=(x,y,z+x(1-x)/4), det(DG)=1. Both cells meet only on the
    // nonplanar parabola-cylinder q=z-x(1-x)/4=0. Linearizing the midside
    // geometry would move that face by 1/16 at x=1/2.
    for tet in [false, true] {
        for paired in [false, true] {
            certify_imported_geometry(&source(tet, paired, shear)).unwrap();
        }
        let mut mm = source(tet, true, shear);
        for p in &mut mm.coords {
            *p /= 1024.;
        }
        certify_imported_geometry(&mm).unwrap();
        let mut rotated = source(tet, true, shear);
        for p in rotated.coords.chunks_exact_mut(3) {
            let [x, y, z] = [p[0], p[1], p[2]];
            p.copy_from_slice(&[-2. * y + z / 4., x + z / 2., 4. * z]);
        }
        certify_imported_geometry(&rotated).unwrap();
    }
}

#[test]
fn exact_quadratic_certificate_rejects_folds_even_with_positive_center_jacobian() {
    // dx/du=5/2-3u: center is +1, but the u=1 corner is -1/2.
    for tet in [false, true] {
        let mesh = source(tet, false, |[x, y, z]| [x + 1.5 * x * (1. - x), y, z]);
        let error = certify_imported_geometry(&mesh).unwrap_err();
        let description = format!("{error:?}");
        assert!(description.starts_with("Invalid"));
        assert!(description.contains("nonpositive exact Jacobian"));
    }
}

#[test]
fn quadratic_broad_phase_cannot_hide_between_node_bulge_overlap() {
    // z_top=1+u/4-u²/2 reaches 1+1/32 at u=1/4, while every
    // authored node has z<=1. A nodal AABB would incorrectly skip this overlap.
    let mut mesh = source(false, false, |[x, y, z]| [x, y, z + (x / 2. - x * x) / 2.]);
    assert!(mesh.coords.chunks_exact(3).all(|p| p[2] <= 1.));
    let other = source(false, false, |[x, y, z]| [3. / 16. + x / 8., 1. / 4. + y / 2., 1. + 1. / 64. + z / 32.]);
    let offset = mesh.n_nodes() as u32;
    mesh.coords.extend(other.coords);
    mesh.blocks[0].conn.extend(other.blocks[0].conn.iter().map(|n| n + offset));
    assert!(certify_imported_geometry(&mesh).is_err());
}

#[test]
fn quartic_implicit_interface_is_inconclusive_without_replacing_original_faces() {
    // G=(x+z²/8,y+x²/8,z), det=1. The v=0 face has equation
    // y=(x-z²/8)²/8: irreducibly quartic, outside the quadric separator family.
    // Reorient the paired source so their shared plane is original y=0.
    let mesh = source(false, true, |[x, y, z]| [x + y * y / 8., z + x * x / 8., -y]);
    assert!(format!("{:?}", certify_imported_geometry(&mesh).unwrap_err()).starts_with("Inconclusive"));
}

#[test]
fn curved_tetrahedral_slanted_shared_face_uses_the_excluded_zero_barycentric_coordinate() {
    let mut mesh = source(true, false, shear);
    let mut points: Vec<[f64; 3]> = mesh.coords.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
    for [r, s, t] in reference(true) {
        // Vertices (1,0,0),(0,1,0),(0,0,1),(1,1,1): determinant2.
        // The first cell's shared face is λ0=0, not an axis-aligned reference face.
        let p = shear([1. - r - s, r + t, s + t]);
        let id = if let Some(id) = points.iter().position(|q| *q == p) {
            id
        } else {
            points.push(p);
            points.len() - 1
        };
        mesh.blocks[0].conn.push(id as u32);
    }
    mesh.coords = points.into_iter().flatten().collect();
    certify_imported_geometry(&mesh).unwrap();
}
